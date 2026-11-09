# Security

## Reporting a vulnerability

Write to **privacy@deigma.net**, the address https://deigma.net/privacy publishes as the contact.
Please do not open a public issue or pull request for a vulnerability; send the details there.

A useful report says what you found, how to reproduce it (the version of `deigma` or of the
extension, your operating system, your Node version) and what it lets someone do.

## What counts

This repository: the `deigma` command, the editor extension and the wire schemas. In particular:

- anything that makes the client read or send more than the list at https://deigma.net/audit says:
  a prompt, code, a file path, a secret;
- anything that lets another program, or a web page, read what the client keeps on your machine
  or act as you;
- a weakness in the sign-in (the device flow) or in how the client stores its session.

The service itself (the API and the web app) is not in this repository. A problem there goes to the
same address.

## Versions

The latest `deigma` on npm and the latest release of the extension.
