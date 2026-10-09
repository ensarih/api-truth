# Locked dependency inventory

Run the read-only inventory from the repository root:

```sh
npm run dependencies:inventory
```

Or select a project root explicitly:

```sh
node scripts/dependency-inventory.mjs --root /path/to/checkout
```

The report reads only the root `package-lock.json` v3 and bounded `package.json`
metadata for installed locked packages. It does not import or execute packages,
install dependencies, contact registries, or print absolute paths or resolved
URLs. It records exact locked versions, installed-version checks, production,
development and optional status, registry hostnames, and license metadata. A
missing optional package is identified separately; its license can still come
from the lockfile when recorded there. Local npm workspace links are listed
separately from third-party packages.

The output is intentionally scoped. It excludes nested lockfiles for isolated
runtime fixtures and does not inventory the JDK or other external toolchains.
The `rootLockMetadataComplete` field only means that this inventory has no
detected metadata gaps in the root-lock scope. It does not indicate publication
readiness, license acceptance, compatibility, or security.

License expressions are classified using a small explicit SPDX identifier
allow-list and syntax check. An unrecognized expression, object-valued
metadata, missing metadata, uninstalled required package, or installed version
mismatch is reported as a gap and prevents `rootLockMetadataComplete`. The
report does not decide whether any license is suitable for this project. Review the
complete applicable license texts and the distribution scope before release.

The inventory is deterministic for the same lockfile and installed package
metadata. Re-run it after dependency changes and preserve the output with the
release review; it does not modify or create an inventory artifact itself.
