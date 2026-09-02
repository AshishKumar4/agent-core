// A stand-in for the exchange child, so the parent's side of the synchronous bridge is
// tested without a network.
//
// The real child performs one asynchronous completion through the harness's model port.
// What the parent owes, and what this exercises, is everything around that call: the
// request it writes to the child's standard input, the strict reading of whatever the child
// writes back, and the failure it reports when there is no answer. The reply is chosen by
// the requested model name, so one fixture drives every branch the parent has.
import { readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(0, "utf8"));

if (request.model === "exit-nonzero") {
    process.stderr.write("the child could not start\nand said so twice\n");
    process.exit(3);
}
if (request.model === "not-json") {
    process.stdout.write("I am not a reply record.\n");
    process.exit(0);
}
if (request.model === "failure") {
    process.stdout.write(`${JSON.stringify({ failure: "model.unavailable: endpoint refused" })}\n`);
    process.exit(0);
}
if (request.model === "failure-unreadable") {
    process.stdout.write(`${JSON.stringify({ failure: 7 })}\n`);
    process.exit(0);
}
if (request.model === "textless") {
    process.stdout.write(`${JSON.stringify({ usage: { inputTokens: 1, outputTokens: 1 } })}\n`);
    process.exit(0);
}
if (request.model === "usageless") {
    process.stdout.write(`${JSON.stringify({ text: "answered without a usage record" })}\n`);
    process.exit(0);
}
// The echo case: the parent's own request, handed back as the model's text, so a test can
// assert what crossed the boundary — including that the credential travelled on standard
// input rather than in an argument vector.
process.stdout.write(
    `${JSON.stringify({
        text: JSON.stringify(request),
        usage: { inputTokens: 13, outputTokens: 5 }
    })}\n`
);
