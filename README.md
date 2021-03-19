# jalfi
Compiler written using the Sif tokenizer/lexer.

##### Dependencies
Jalfi compiles down to LLVM IR then uses GCC for linking.

**HelloWorld.jf**
```jalfi
int main() {
  println("Hello World");
  return 0;
}
```

##### Compiling & Running
```bash
$ ./jalfi HelloWorld.jf
$ ./HelloWorld
Hello World
```
