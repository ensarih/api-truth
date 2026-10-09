# Security policy

## Reporting a vulnerability

Please report security vulnerabilities through GitHub's private vulnerability
reporting form for this repository:

<https://github.com/ensarih/api-truth/security/advisories>

On that page, choose **Report a vulnerability**. This private reporting option
must be enabled for the repository. Do not report vulnerabilities in public
issues, discussions, or pull requests. If the private reporting option is not
available, do not post sensitive details publicly; wait until the repository
offers a private reporting route.

Do not include live credentials, private source code, production logs, or other
unnecessary sensitive data in a report. A minimal reproduction using synthetic
data is preferred where possible.

There is no published response-time commitment or supported-release schedule.
The project is under active development, and no released version is currently
designated as supported. Coordinate any public disclosure with the maintainers
through the private report.

## Scope and testing

The project has bounded analyzers, connectors, and local service workflows.
Automated checks use synthetic fixtures and disposable local test services;
passing them is not a security audit or a guarantee that every deployment is
secure. Reports about the current development code are welcome through the
private route above.
