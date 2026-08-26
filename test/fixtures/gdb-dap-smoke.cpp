#include <cstdint>

volatile std::int32_t watched_value = 1;

__attribute__((noinline)) void mutate_value() {
    watched_value = 42;
}

int main() {
    watched_value = 7;
    mutate_value();
    return watched_value == 42 ? 0 : 1;
}
