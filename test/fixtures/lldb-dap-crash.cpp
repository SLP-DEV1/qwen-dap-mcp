#include <cstdint>

static int crash_now() {
    volatile std::int32_t* pointer = nullptr;
    return *pointer;
}

int main() {
    return crash_now();
}
