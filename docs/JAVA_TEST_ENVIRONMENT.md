# Project-local Java test environment

The Java analyzer does not use the system JDK. This helper prepares a pinned
Eclipse Temurin JDK 21 runtime inside `.cache/java-test/`; it does not install
globally, change `JAVA_HOME`, build a project, or run analyzer/source code.

Supported targets are macOS x64/arm64 and Linux x64/arm64. The exact release is
Temurin `21.0.12.1+1` (`jdk-21.0.12.1+1`). The helper uses fixed release asset
URLs and SHA-256 values recorded from the [official Adoptium binary release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1):

| Target | Asset | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz` | `3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998` |
| macOS x64 | `OpenJDK21U-jdk_x64_mac_hotspot_21.0.12.1_1.tar.gz` | `44db0f08196daf19a47f90d13388b0c943b67663cb537f998fe29e836fa842ce` |
| Linux x64 | `OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz` | `ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94` |
| Linux arm64 | `OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz` | `23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223` |

## Prepare and check

Prepare the pinned runtime and check it offline:

```sh
npm run java:env:up
npm run java:env:ready
```

`up` downloads only the matching pinned asset, with a 300 MiB transfer cap and
15-minute deadline. It checks the archive digest before extraction and caps
the archive listing at 100,000 entries. It validates archive paths, extracts
into a temporary directory inside the project cache, checks extracted
symlinks remain contained, then rejects a resulting file tree above 1 GiB or
100,000 entries and removes the temporary data. The expanded-tree size check
is post-extraction, not a hard disk quota; the archive is checked against its
pinned digest before extraction. Each manual redirect is limited to five
hops and rechecked for HTTPS on the fixed GitHub release hosts; no credentials
or custom headers are forwarded. On macOS the JDK home is under
`runtime/Contents/Home`; on Linux it is `runtime/`.
It does not overwrite an existing partial cache; remove that one cache
directory manually if setup reports that it is incomplete.

`ready` is offline. It verifies the retained archive digest, re-extracts that
verified archive into a temporary project-cache directory, and compares the
complete file/symlink tree with the installed runtime before invoking only the
cached `java -version` binary to check the exact release. This makes the
integrity check independent of the cache's saved manifest. It does not consult
or modify a global Java installation or `JAVA_HOME`.
The saved manifest is streamed with a 16 MiB cap before JSON parsing. The
version probe runs with an empty environment, so inherited Java options,
agents, classpaths, and environment hooks cannot affect it.

The downloaded JDK is used as a test prerequisite only. This helper does not
run Java projects, build scripts, plugins, compiler tasks, or analyzer inputs.
