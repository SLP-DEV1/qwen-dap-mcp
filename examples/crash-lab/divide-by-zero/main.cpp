#include <cstdint>

#if defined(_MSC_VER)
#define NOINLINE __declspec(noinline)
#else
#define NOINLINE __attribute__((noinline))
#endif

NOINLINE int divide(std::int32_t numerator, std::int32_t denominator) {
    volatile std::int32_t divisor = denominator;
    volatile std::int32_t value = numerator / divisor;
    return value;
}

int main(int argc, char**) {
    // With the normal no-argument reproduction argc == 1, so denominator == 0.
    return divide(42, argc - 1);
}
