# Security Policy — RedpointAI

## Overview

RedpointAI is an open-source connector that lets customers interact with their existing Redpoint Interaction (RPI) platform using natural language through a chat interface. It is published and maintained by Redpoint Global Inc. under the [Apache License 2.0](./LICENSE).

This document describes how to report security vulnerabilities, how Redpoint responds to them, and the security responsibilities that apply to customers who deploy RedpointAI in their own environments.

## Supported Versions

This repository is published as source, as-is, under the Apache License 2.0. Security fixes land on the default branch; there are no maintenance branches or backports. Run the current state of the default branch. Security advisories, when issued, are published via [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories).

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Redpoint operates a Security Response Center for coordinated vulnerability disclosure. If you believe you have found a security vulnerability in RedpointAI, report it privately by email:

📧 **secure@redpointglobal.com**

Please include in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (do not include live credentials or sensitive data)
- The version of RedpointAI affected
- Any relevant environment details (OS, deployment model, dependencies)

### Response Process

All stages are handled through the Security Response Center; severity drives prioritization. No service-level commitment is expressed or implied.

| Stage                                          | Channel                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Report and acknowledgement                     | **secure@redpointglobal.com**                                        |
| Triage and severity assessment                 | **secure@redpointglobal.com** (reporter kept in the loop)            |
| Fix or mitigation for Critical/High findings   | Updated source on the default branch + advisory                     |
| Coordinated public disclosure                  | [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories) |

We ask that reporters follow coordinated disclosure practices and refrain from publishing vulnerability details until a fix is available or 90 days have elapsed from the report, whichever comes first.

## Shared Responsibility Model

RedpointAI is **customer-hosted software**. Customers build it from source and run it themselves, against their own RPI instance, on their own infrastructure. Redpoint does not host, operate, or have visibility into customer deployments.

| Security Area              | Redpoint Responsibility                                                                  | Customer Responsibility                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| RedpointAI source code     | Publish patches and security advisories for vulnerabilities in RedpointAI code           | Apply published updates in a timely manner                                                               |
| Bundled dependencies       | Address vulnerabilities in bundled dependencies in the published source as they are identified | Monitor Redpoint security advisories; update deployed versions                                           |
| Deployment infrastructure  | Not applicable — Redpoint does not host customer deployments                             | Secure the infrastructure on which RedpointAI is deployed (network exposure, access controls, TLS)       |
| RPI API credentials        | Not applicable — credentials are customer-managed                                        | Protect RPI API credentials used by RedpointAI; rotate upon suspected compromise                         |
| Data handled by RedpointAI | Not applicable — customer data stays in the customer's RPI environment                   | Ensure RedpointAI is deployed with appropriate access controls to RPI data                               |
| AI model interactions      | Document known AI-specific considerations in this policy (see below)                     | Implement appropriate controls for AI model usage in your environment                                    |
| Security monitoring        | Not applicable for customer-hosted deployments                                           | Monitor the RedpointAI deployment for anomalous activity                                                 |

> **In plain terms:** Redpoint is responsible for the security of the code we publish. You are responsible for how and where you deploy it.

## Security Hardening Guidance

The following minimum practices are strongly recommended for all RedpointAI deployments.

### Network Exposure

- Do not expose RedpointAI directly to the public internet. Deploy it behind a reverse proxy, API gateway, or internal network boundary appropriate to your environment.
- Restrict inbound access to trusted sources only.

### Authentication

- Require authentication for all RedpointAI endpoints before deployment. Do not run RedpointAI without access controls in place.
- Scope access to the minimum set of users who require it.

### Transport Security

- Use TLS 1.2 or higher for all connections between RedpointAI and the RPI API.
- Do not transmit RPI API credentials or session tokens over unencrypted connections.

### RPI API Credentials

- Scope RPI API credentials to the minimum permissions required for RedpointAI's functions (principle of least privilege).
- Store credentials using your environment's approved secrets-management solution — do not hardcode them in configuration files or commit them to source control.
- Rotate credentials promptly if compromise is suspected.

### Updates

- Apply Redpoint security updates promptly when advisories are published.
- Enable dependency update tooling (e.g., Dependabot) if you maintain a fork or derivative of this repository.

## Regulated Environments (HIPAA, etc.)

If you are a covered entity or business associate operating in a regulated environment, review RedpointAI's access to RPI data against your applicable minimum-necessary and least-privilege requirements before deployment.

RedpointAI does not process, store, or transmit data on Redpoint's infrastructure. Your organization's regulatory obligations with respect to data handled by RedpointAI remain your responsibility.

## AI-Specific Considerations

- Be aware of **prompt-injection risk**: malicious input passed to the AI model may attempt to manipulate its behavior. Apply input validation appropriate to your threat model.
- Review the [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/) for guidance on AI-specific security controls relevant to your deployment.

## Out of Scope

The following are outside the scope of this security policy:

- Vulnerabilities in the underlying RPI platform — report these through your Redpoint support channel
- Vulnerabilities in the Vercel AI SDK or other third-party dependencies — report these to the respective upstream maintainers
- Security issues arising from customer misconfiguration or failure to follow the hardening guidance above
- Redpoint Interaction (RPI) product code, algorithms, or proprietary systems — these are not part of this repository

## License and Trademark

RedpointAI is licensed under the [Apache License 2.0](./LICENSE). This license does not grant any rights to use the Redpoint, RPI, or RedpointAI trademarks, logos, or brand assets. See Apache License 2.0 §6.

## Contact

**Security Response Center:** secure@redpointglobal.com
Redpoint Global Inc., 34 Washington Street Suite 205, Wellesley Hills, MA 02481

For non-security issues, email **support@redpointglobal.com** (see [SUPPORT.md](./SUPPORT.md)).
