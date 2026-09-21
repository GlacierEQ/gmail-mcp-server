# UPORTAL Deployment Strategy

## Objective

UPORTAL is a first-party engagement sensor for controlled notice evidence. The runtime must remain replaceable; evidence and execution truth must not depend on a particular hosting vendor.

## Runtime contract

A production UPORTAL target must provide all of the following:

- Linux container execution.
- Durable writable storage mounted at `/data/files`.
- Stable HTTPS origin.
- Provider-managed runtime secrets.
- A single verified active writer for the UPORTAL file store.
- Provider-native deployment/readback receipts.
- Restart/redeploy persistence verification before operational use.

The privacy/evidence-minimal patch is mandatory. Raw IP, forwarded IP, user agent, accept-language, referrer, persistent recipient UID/cookie, and fingerprint inputs remain discarded before raw event persistence.

## Portable image profile

The normal GitHub push path publishes a host-neutral multi-architecture image for:

- `linux/amd64`
- `linux/arm64`

Portable releases use `https://localhost` only as the build-time default for the bundled admin UI and Thunderbird package. Runtime API behavior is configured by provider secrets/environment at deployment.

Published convenience tags:

- `ghcr.io/glaciereq/gmail-mcp-server-uportal:0.2.54`
- `ghcr.io/glaciereq/gmail-mcp-server-uportal:live`

Each push also publishes a commit-bound tag:

- `ghcr.io/glaciereq/gmail-mcp-server-uportal:sha-<git-sha>`

The build emits OCI provenance and an SBOM.

## Domain-bound image profile

When the bundled admin UI or Thunderbird package must default to the final public origin, dispatch the publish workflow manually with `uportal_base_url=https://<final-host>`.

A domain-bound dispatch never overwrites the portable `live`, `0.2.54`, or `sha-<git-sha>` tags. It publishes run-scoped tags instead:

- `domain-<github-run-id>`
- `sha-<git-sha>-run-<github-run-id>`

This prevents an endpoint-specific rebuild from silently mutating the portable commit-tagged runtime.

## Provider-selection law

Select a host from live provider readback, never from cached inventory alone.

Preferred route:

1. Reuse an already-running owned Linux compute target when provider readback proves it exists and is reachable.
2. Otherwise provision or restore a Linux target with durable storage, preferring an ARM64-capable route when it materially reduces cost.
3. Managed container hosting is an acceptable alternate when it provides a real persistent volume and provider-native receipts.
4. A stateless container/serverless target is not equivalent. Use it only after UPORTAL persistence has been deliberately externalized and tested.

A provider block changes the route, not the runtime/evidence objective.

## Evidence authority and projections

UPORTAL publication/activity records remain provider-native source evidence for the sensor. Gmail/forensic ledgers and Supabase projections may normalize, correlate, hash, and receipt those events, but must not silently rewrite the source event.

Every operational transition should preserve:

- Git commit SHA.
- Image tag and digest.
- Hosting provider resource/deployment ID.
- Public HTTPS origin.
- Runtime configuration version, excluding secret values.
- Health/readback result.
- Test publication ID/token.
- Test activity readback.
- Privacy-minimization verification.
- Persistence-after-restart result.
- Gmail evidence-ingestion receipt.

Unknown or partial state stays unknown or partial; it is never promoted to success.

## Activation sequence

1. Prove the compute/resource exists with provider-native readback.
2. Attach or verify durable `/data/files`.
3. Deploy the commit-bound portable image or a deliberate domain-bound image.
4. Generate fresh high-entropy runtime secrets in the provider secret manager.
5. Attach the stable HTTPS origin.
6. Configure Gmail MCP with the final `UPORTAL_BASE_URL` and matching user token.
7. Verify `GET /ui/`.
8. Publish a controlled test pixel/resource.
9. Generate a controlled test event.
10. Query activity and verify no prohibited raw recipient/network/device identifiers were retained.
11. Verify the Gmail evidence pipeline ingests the event.
12. Restart/redeploy and prove the UPORTAL state survived.
13. Write the provider-native receipts back into the GlacierEQ control plane.
