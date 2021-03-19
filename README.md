# jalfi
Compiler (stupid and minimal) written using the Sif tokenizer/lexer.

##### Dependencies
Jalfi compiles down to LLVM IR then uses GCC for linking.

**HelloWorld.jf**
```jalfi
int main() {
  print("Hello World");
  return 0;
}
```

##### Compiling & Running
```bash
$ ./jalfi HelloWorld.jf
$ ./HelloWorld
Hello World
```
