#include <atomic>
#include <chrono>
#include <thread>

struct RuntimeObject {
  virtual ~RuntimeObject() = default;
  virtual int score() const { return value; }
  int value = 42;
};

std::atomic<bool> keep_worker{true};
volatile int watched_value = 7;

void worker_loop() {
  while (keep_worker.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
}

void replace_object(RuntimeObject*& object) {
  watched_value = 9;
  object = nullptr;
}

int exercise_object(RuntimeObject*& object) {
  int marker = object->score();
  std::this_thread::sleep_for(std::chrono::milliseconds(2000)); // RUNTIME_V2_BREAKPOINT
  replace_object(object);
  return marker;
}

int main() {
  RuntimeObject* object = new RuntimeObject();
  std::thread worker(worker_loop);

  int marker = exercise_object(object);
  keep_worker = false;
  worker.join();

  delete object;
  return marker == 42 ? 0 : 1;
}
