#include <atomic>
#include <chrono>
#include <thread>

struct Base {
    virtual ~Base() = default;
    virtual int value() const { return 7; }
};

volatile int progress_counter = 0;

int main() {
    Base first;
    Base second;
    Base* ptr = &first;
    std::atomic<bool> run{true};

    std::thread worker([&]() {
        while (run.load(std::memory_order_relaxed)) {
            ++progress_counter;
            std::this_thread::yield();
        }
    });

    int local_progress = 0;
    // RUNTIME_V2_BREAK
    for (int i = 0; i < 5000000; ++i) {
        ++local_progress;
        if (i == 1000) ptr = &second;
        if ((i % 1000) == 0) std::this_thread::yield();
    }

    run.store(false, std::memory_order_relaxed);
    worker.join();
    return ptr->value() == 7 && local_progress > 0 ? 0 : 1;
}
