#include <cstdint>

#if defined(_MSC_VER)
#define NOINLINE __declspec(noinline)
#else
#define NOINLINE __attribute__((noinline))
#endif

struct Payload {
    std::int32_t value;
};

NOINLINE int read_payload(const Payload* payload) {
    volatile std::int32_t value = payload->value;
    return value;
}

int main() {
    const Payload* payload = nullptr;
    return read_payload(payload);
}
