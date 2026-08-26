#include <cstring>

volatile int sink = 0;

__attribute__((noinline))
int inspect_case(int* critical_ptr, int stable_count) {
  sink += stable_count;
  if (critical_ptr != nullptr) sink += *critical_ptr;
  return stable_count + (critical_ptr == nullptr ? 1 : 0);
}

__attribute__((noinline))
int good_path() {
  int storage = 7;
  return inspect_case(&storage, 42);
}

__attribute__((noinline))
int bad_path() {
  return inspect_case(nullptr, 42);
}

int main(int argc, char** argv) {
  const bool bad = argc > 1 && std::strcmp(argv[1], "bad") == 0;
  return (bad ? bad_path() : good_path()) > 0 ? 0 : 1;
}
