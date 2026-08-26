#include <cstring>

volatile int sink = 0;

__attribute__((noinline))
int observe_case(bool bad) {
  int storage = 7;
  int stable_count = 42;
  int* critical_ptr = bad ? nullptr : &storage;
  sink += stable_count;
  if (critical_ptr != nullptr) sink += *critical_ptr;
  return stable_count + (critical_ptr == nullptr ? 1 : 0);
}

int main(int argc, char** argv) {
  const bool bad = argc > 1 && std::strcmp(argv[1], "bad") == 0;
  return observe_case(bad) > 0 ? 0 : 1;
}
