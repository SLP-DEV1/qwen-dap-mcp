#include <cstdint>

using Callback = std::int32_t (*)(std::int32_t);

#if defined(_MSC_VER)
#define NOINLINE __declspec(noinline)
#else
#define NOINLINE __attribute__((noinline))
#endif

NOINLINE std::int32_t invoke(Callback callback, std::int32_t value) {
    return callback(value);
}

int main() {
    Callback callback = nullptr;
    return invoke(callback, 42);
}
