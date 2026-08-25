#include <iostream>

int main() {
    int counter = 35;
    int delta = 7;
    counter += delta; // BREAKPOINT
    std::cout << "counter=" << counter << std::endl;
    return counter == 42 ? 0 : 1;
}
