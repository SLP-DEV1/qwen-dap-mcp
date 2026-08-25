#include <chrono>
#include <iostream>
#include <thread>

int main() {
    int counter = 35;
    int delta = 7;
    counter += delta; // BREAKPOINT
    std::cout << "counter=" << counter << std::endl;
    std::this_thread::sleep_for(std::chrono::seconds(2));
    return counter == 42 ? 0 : 1;
}
