using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// A small GUI-subsystem process: no console, shell, Electron runtime or access
// to usage credentials. It observes window presence and starts the installed
// overlay once per ChatGPT window session.
internal static class ChatGptLaunchWatcher
{
    private const int PollMilliseconds = 1000;
    private const int MaximumConfigBytes = 16384;
    private const int MaximumLaunchFailures = 5;
    private const uint QueryLimitedInformation = 0x1000;
    private const int ExtendedStyle = -20;
    private const int ToolWindow = 0x80;
    private const uint OwnerWindow = 4;

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowRect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out WindowRect rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint capacity);

    private sealed class Config
    {
        public string AppPath;
    }
    private enum ConfigResult { Ready, Stop, Retry }

    [STAThread]
    private static void Main(string[] arguments)
    {
        // Config files may disappear during uninstall or an update. Nothing
        // here should display a dialog, log secrets, or keep the PC awake.
        try { Run(arguments); }
        catch { if (arguments.Length == 1 && arguments[0] == "--stop") Environment.ExitCode = 1; }
    }

    private static void Run(string[] arguments)
    {
        int session, processId;
        using (Process ownProcess = Process.GetCurrentProcess()) { session = ownProcess.SessionId; processId = ownProcess.Id; }
        string sid;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            if (identity.User == null) return;
            sid = identity.User.Value;
        }
        string suffix = sid + "." + session.ToString(System.Globalization.CultureInfo.InvariantCulture);
        string stopName = @"Local\CodexUsageOverlay.Watcher.Stop." + suffix;
        string mutexName = @"Local\CodexUsageOverlay.Watcher.Instance." + suffix;
        if (arguments.Length == 1 && arguments[0] == "--stop")
        {
            SignalStop(stopName, mutexName, processId, session);
            return;
        }
        if (arguments.Length != 2 || arguments[0] != "--config" || !IsAbsolutePath(arguments[1])) return;
        string configPath = Path.GetFullPath(arguments[1]);
        Config initial;
        if (ReadConfig(configPath, out initial) == ConfigResult.Stop) return;

        using (Mutex instance = new Mutex(false, mutexName))
        {
            bool acquired;
            try { acquired = instance.WaitOne(0, false); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) return;
            try
            {
                using (EventWaitHandle stop = new EventWaitHandle(false, EventResetMode.ManualReset, stopName))
                {
                    Watch(configPath, session, stop);
                }
            }
            finally { instance.ReleaseMutex(); }
        }
    }

    private static void SignalStop(string name, string mutexName, int ownProcessId, int session)
    {
        List<Process> previous = ExistingWatchers(ownProcessId, session);
        Stopwatch deadline = Stopwatch.StartNew();
        try
        {
            // Cover the brief interval in which a new watcher has acquired its
            // mutex but has not created the stop event yet.
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    using (EventWaitHandle stop = EventWaitHandle.OpenExisting(name)) stop.Set();
                    break;
                }
                catch (WaitHandleCannotBeOpenedException) { if (attempt < 4) Thread.Sleep(100); }
            }
            try
            {
                using (Mutex instance = Mutex.OpenExisting(mutexName))
                {
                    bool acquired;
                    try { acquired = instance.WaitOne(RemainingStopTime(deadline), false); }
                    catch (AbandonedMutexException) { acquired = true; }
                    if (acquired) instance.ReleaseMutex();
                    else Environment.ExitCode = 1;
                }
            }
            catch (WaitHandleCannotBeOpenedException) { }
            // Releasing the instance mutex precedes final CLR shutdown. Wait
            // for the captured processes too, so uninstall/update does not
            // race the executable's final Windows image-file lock.
            foreach (Process process in previous)
            {
                try { if (!process.WaitForExit(RemainingStopTime(deadline))) Environment.ExitCode = 1; }
                catch { Environment.ExitCode = 1; }
            }
        }
        finally { foreach (Process process in previous) process.Dispose(); }
    }

    private static int RemainingStopTime(Stopwatch timer)
    {
        return (int)Math.Max(0L, 5000L - timer.ElapsedMilliseconds);
    }

    private static bool IsWatcherName(string value, string ownName)
    {
        if (String.Equals(value, ownName, StringComparison.OrdinalIgnoreCase)) return true;
        if (value.Length != 24 || !value.StartsWith("watcher-", StringComparison.OrdinalIgnoreCase)) return false;
        for (int index = 8; index < value.Length; index++)
        {
            char character = value[index];
            if (!(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') && !(character >= 'A' && character <= 'F')) return false;
        }
        return true;
    }

    private static List<Process> ExistingWatchers(int ownProcessId, int session)
    {
        List<Process> result = new List<Process>();
        string ownPath = CanonicalPath(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string directory = Path.GetDirectoryName(ownPath), ownName = Path.GetFileNameWithoutExtension(ownPath);
        foreach (Process process in Process.GetProcesses())
        {
            bool keep = false;
            try
            {
                if (process.Id != ownProcessId && process.SessionId == session && IsWatcherName(process.ProcessName, ownName))
                {
                    // Retain this original process handle through WaitForExit,
                    // rather than re-opening an ID that might later be reused.
                    string image = ProcessImagePath(process.Handle);
                    if (image != null && String.Equals(Path.GetDirectoryName(image), directory, StringComparison.OrdinalIgnoreCase))
                    {
                        result.Add(process); keep = true;
                    }
                }
            }
            catch { }
            finally { if (!keep) process.Dispose(); }
        }
        return result;
    }

    private static bool IsAbsolutePath(string value)
    {
        if (String.IsNullOrEmpty(value)) return false;
        foreach (char character in value) if (Char.IsControl(character)) return false;
        if (!Path.IsPathRooted(value)) return false;
        string root = Path.GetPathRoot(value);
        // Path.IsPathRooted also accepts drive-relative paths such as C:app.exe.
        // Only a complete drive root or an absolute UNC root is acceptable.
        if (String.IsNullOrEmpty(root)) return false;
        if (value.StartsWith(@"\\", StringComparison.Ordinal)) return root.Length > 2 && root.IndexOf('\\', 2) > 2;
        return root.Length == 3 && Char.IsLetter(root[0]) && root[1] == ':' && (root[2] == '\\' || root[2] == '/');
    }

    private static string CanonicalPath(string value)
    {
        string full = Path.GetFullPath(value);
        StringBuilder longPath = new StringBuilder(32768);
        uint length = GetLongPathName(full, longPath, (uint)longPath.Capacity);
        return length > 0 && length < longPath.Capacity ? longPath.ToString() : full;
    }

    private static ConfigResult ReadConfig(string file, out Config result)
    {
        result = null;
        try
        {
            FileInfo info = new FileInfo(file);
            if (!info.Exists || info.Length > MaximumConfigBytes) return ConfigResult.Stop;
            string json;
            // Atomic replacement must stay possible while the watcher reads
            // settings, including on Windows where delete sharing is explicit.
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
            {
                if (stream.Length > MaximumConfigBytes) return ConfigResult.Stop;
                char[] text = new char[MaximumConfigBytes + 1];
                int length = reader.ReadBlock(text, 0, text.Length);
                if (length > MaximumConfigBytes) return ConfigResult.Stop;
                json = new string(text, 0, length);
            }
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumConfigBytes;
            serializer.RecursionLimit = 8;
            Dictionary<string, object> raw = serializer.DeserializeObject(json) as Dictionary<string, object>;
            object schema, enabled, path;
            if (raw == null || !raw.TryGetValue("schema", out schema) || !(schema is int) || (int)schema != 1 || !raw.TryGetValue("enabled", out enabled) || !(enabled is bool)) return ConfigResult.Retry;
            if (!(bool)enabled) return ConfigResult.Stop;
            if (!raw.TryGetValue("appPath", out path) || !(path is string) || !IsAbsolutePath((string)path)) return ConfigResult.Stop;
            string appPath = CanonicalPath((string)path);
            if (!String.Equals(Path.GetExtension(appPath), ".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(appPath)) return ConfigResult.Stop;
            result = new Config { AppPath = appPath };
            return ConfigResult.Ready;
        }
        catch (FileNotFoundException) { return ConfigResult.Stop; }
        catch (DirectoryNotFoundException) { return ConfigResult.Stop; }
        catch (UnauthorizedAccessException) { return ConfigResult.Stop; }
        catch { return ConfigResult.Retry; }
    }

    private static void Watch(string configPath, int session, EventWaitHandle stop)
    {
        bool cycleHandled = false;
        DateTime? absentSince = null;
        DateTime retryAt = DateTime.MinValue;
        int launchFailures = 0, invalidConfig = 0;
        while (!stop.WaitOne(0))
        {
            Config config;
            ConfigResult result = ReadConfig(configPath, out config);
            if (result == ConfigResult.Stop) return;
            if (result == ConfigResult.Retry)
            {
                if (++invalidConfig >= 3) return;
                if (stop.WaitOne(PollMilliseconds)) return;
                continue;
            }
            invalidConfig = 0;
            DateTime now = DateTime.UtcNow;
            if (HasChatGptWindow(session))
            {
                absentSince = null;
                if (!cycleHandled && now >= retryAt)
                {
                    if (IsOverlayRunning(config.AppPath, session) || TryLaunch(config.AppPath))
                    {
                        cycleHandled = true;
                        launchFailures = 0;
                    }
                    else
                    {
                        launchFailures++;
                        retryAt = now.AddSeconds(30);
                        if (launchFailures >= MaximumLaunchFailures) cycleHandled = true;
                    }
                }
            }
            else
            {
                if (!absentSince.HasValue) absentSince = now;
                if ((now - absentSince.Value).TotalSeconds >= 2)
                {
                    cycleHandled = false;
                    launchFailures = 0;
                    retryAt = DateTime.MinValue;
                }
            }
            if (stop.WaitOne(PollMilliseconds)) return;
        }
    }

    private static bool HasChatGptWindow(int session)
    {
        bool found = false;
        EnumWindows(delegate(IntPtr window, IntPtr ignored)
        {
            try
            {
                WindowRect rect;
                if (!IsWindowVisible(window) || GetWindow(window, OwnerWindow) != IntPtr.Zero || (GetWindowLong(window, ExtendedStyle) & ToolWindow) != 0 || !GetWindowRect(window, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                if (processId == 0 || processId > Int32.MaxValue) return true;
                using (Process process = Process.GetProcessById((int)processId))
                {
                    found = process.SessionId == session && String.Equals(process.ProcessName, "ChatGPT", StringComparison.OrdinalIgnoreCase);
                }
                return !found;
            }
            catch { return true; }
        }, IntPtr.Zero);
        return found;
    }

    private static bool IsOverlayRunning(string appPath, int session)
    {
        Process[] processes;
        try { processes = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(appPath)); }
        catch { return false; }
        bool found = false;
        foreach (Process process in processes)
        {
            try
            {
                if (!found && process.SessionId == session)
                {
                    string image = ProcessImagePath(process.Id);
                    found = image != null && String.Equals(image, appPath, StringComparison.OrdinalIgnoreCase);
                }
            }
            catch { }
            finally { process.Dispose(); }
        }
        return found;
    }

    private static string ProcessImagePath(int processId)
    {
        IntPtr handle = OpenProcess(QueryLimitedInformation, false, processId);
        if (handle == IntPtr.Zero) return null;
        try { return ProcessImagePath(handle); }
        finally { CloseHandle(handle); }
    }

    private static string ProcessImagePath(IntPtr handle)
    {
        int length = 32768;
        StringBuilder image = new StringBuilder(length);
        return QueryFullProcessImageName(handle, 0, image, ref length) ? CanonicalPath(image.ToString()) : null;
    }

    private static bool TryLaunch(string appPath)
    {
        try
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = appPath;
            start.Arguments = "--chatgpt-autostart";
            start.WorkingDirectory = Path.GetDirectoryName(appPath);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            using (Process process = Process.Start(start)) return process != null;
        }
        catch { return false; }
    }
}
