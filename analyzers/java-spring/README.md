# Java/Spring MVC AST analyzer

`java-spring-mvc@0.1.0` is a bounded, declaration-only IR 1.0.0 profile. It uses
the pinned project-local Temurin 21 runtime and JavaParser core 3.28.2. Prepare
the JDK first, then explicitly prepare the parser toolchain:

```sh
node scripts/java-test-environment.mjs up
node scripts/java-parser-toolchain.mjs up
node scripts/java-parser-toolchain.mjs ready
```

Analysis itself is offline. It accepts exactly one digest-bound `source_tree`,
reads contained UTF-8 `.java` files, copies those bytes to a private temporary
directory, and launches a bounded Java AST projection helper. The helper does
not compile or execute service source. The toolchain bootstrap compiles only
the analyzer's fixed `AstExtract.java` with `javac -proc:none` and the
checksum-pinned JavaParser core jar. It never invokes Maven, Gradle, project
wrappers, annotation processors or service dependencies.

The first slice recognizes explicit Spring MVC annotation imports,
`@RestController`, a literal class `@RequestMapping`, and literal
`@GetMapping`/`@PostMapping`/`@PutMapping`/`@PatchMapping`/`@DeleteMapping`.
It records literal header-equality, consumes and produces selectors in endpoint
identity, with source spans and immutable revision evidence. It deliberately
keeps coverage partial: syntactic imports do not prove the Spring classpath or
startup registration. DTO fields, Bean Validation, inherited mappings,
response status, security, project-specific constants, and runtime behavior
remain unknown or are diagnosed. No schema, requiredness, status, or security
is inferred from method names or type declarations in this profile.

The CLI reads one full AnalyzerRequest JSON value from standard input and
writes one validated AnalyzerResult JSON value. Its optional first argument is
the project root. Malformed input, unavailable toolchain, source boundary
failures and process failures return fixed error codes without source content.
