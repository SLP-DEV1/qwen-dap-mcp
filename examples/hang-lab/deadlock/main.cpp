#include <atomic>
#include <iostream>
#include <mutex>
#include <thread>

namespace {
std::mutex left_mutex;
std::mutex right_mutex;
std::atomic<int> first_locks_held{0};

void wait_until_both_first_locks_are_held() {
  first_locks_held.fetch_add(1, std::memory_order_acq_rel);
  while (first_locks_held.load(std::memory_order_acquire) < 2) {
    std::this_thread::yield();
  }
}

void left_worker() {
  std::lock_guard<std::mutex> first(left_mutex);
  wait_until_both_first_locks_are_held();
  std::lock_guard<std::mutex> second(right_mutex);
  std::cerr << "left worker unexpectedly acquired both locks\n";
}

void right_worker() {
  std::lock_guard<std::mutex> first(right_mutex);
  wait_until_both_first_locks_are_held();
  std::lock_guard<std::mutex> second(left_mutex);
  std::cerr << "right worker unexpectedly acquired both locks\n";
}
}  // namespace

int main() {
  std::cout << "hang-lab: entering deterministic two-lock deadlock\n" << std::flush;
  std::thread left(left_worker);
  std::thread right(right_worker);
  left.join();
  right.join();
  return 0;
}
