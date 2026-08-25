#include <windows.h>
#include <dbghelp.h>

#pragma comment(lib, "dbghelp.lib")

static LONG WINAPI write_minidump(EXCEPTION_POINTERS* exceptionPointers) {
  HANDLE file = CreateFileW(
      L"native-dump.dmp",
      GENERIC_WRITE,
      0,
      nullptr,
      CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);

  if (file == INVALID_HANDLE_VALUE) {
    return EXCEPTION_EXECUTE_HANDLER;
  }

  MINIDUMP_EXCEPTION_INFORMATION exceptionInfo{};
  exceptionInfo.ThreadId = GetCurrentThreadId();
  exceptionInfo.ExceptionPointers = exceptionPointers;
  exceptionInfo.ClientPointers = FALSE;

  const auto dumpType = static_cast<MINIDUMP_TYPE>(
      MiniDumpNormal | MiniDumpWithThreadInfo | MiniDumpWithDataSegs);

  MiniDumpWriteDump(
      GetCurrentProcess(),
      GetCurrentProcessId(),
      file,
      dumpType,
      &exceptionInfo,
      nullptr,
      nullptr);

  CloseHandle(file);
  return EXCEPTION_EXECUTE_HANDLER;
}

__declspec(noinline) int crash_here(int* pointer) {
  volatile int local_marker = 77;
  return *pointer + local_marker;  // intentional access violation for dump CI
}

int main() {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  SetUnhandledExceptionFilter(write_minidump);

  volatile int pre_crash_marker = 1234;
  (void)pre_crash_marker;

  int* pointer = nullptr;
  return crash_here(pointer);
}
