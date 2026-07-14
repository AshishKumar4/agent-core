# W8 normative clarification requests

These requests are not implementation claims. W8 remains private until the owning
specification work accepts or rejects them.

## Environment pin identity

`RunPins.environmentRevision` does not identify one Environment when a Blueprint
declares more than one.

Requested text:

> Replace `environmentRevision` with `environment: { id: EnvironmentId;
> revision: Revision }`. A referenced Environment revision remains resolvable while
> a Run, Session, or Snapshot references it.

## Filesystem mutation evidence and readonly wrappers

Requested text:

> A mutating Filesystem Operation returns the standard mediated Invocation Receipt;
> it does not define a profile-specific Receipt. Add `read-only` to the stable
> Filesystem error set, or declare readonly wrappers to expose only the reader
> contract.

## Source Event audit causality

The profiles name `task.actionSubmitted`, `command.invoked`, verified ingress, and
scheduler source Events without identifying the Receipt that legally causes each Event.

Requested text:

> A profile source action enters as an ordinary mediated Invocation and reaches
> `Receipt -> Event -> RouteReserved` through the existing closed causal relation.
> Specify the host Operation and Receipt outcome for each standard source Event; do not
> add a WriteRecord-to-Event edge or a new Event audit root.

## MCP reproducibility

Requested text:

> Each Agent Core edition pins an exact MCP protocol revision, defines the MCP
> annotation mapped to Agent Core Impact, and sets positive finite prompt item and
> byte maxima. Unknown impact metadata rejects discovery. Remote tools default to
> `externalSend`.

## Device consent admission

Requested text:

> Publish versioned schemas for camera, location, SMS, screen, `system.run`, and
> cached-result reads. Consent is exact per device and Agent. Revocation committed
> before the final pre-effect consent check denies without an EffectAttempt; it does
> not cancel an already-admitted external effect.

## Slate rollback

Requested text:

> `rollback` changes the active successful deployment pointer without contacting a
> provider. Applying a new external deployment remains `deploy` with
> `externalSend` impact.

## Cloudflare mediated authority linearization

Current Tenant epochs and target-local pre-effect evidence cannot be committed in one
transaction across Durable Objects.

Requested text:

> Tenant authority admission issues a short-lived, intent-bound permit linearized
> against Grant and epoch mutation. It binds Actor, Invocation, item, intent digest,
> path epochs, authority source, optional LeaseToken, and expiry. Each enforcing Actor
> owns its monotonic delivered-watermark projection and atomically consumes admission
> or joins stale epochs while recording pre-effect denial.
