import { describe, expect, test } from "vitest";
import {
    PackageInstallationProvenancePort,
    consumeAuthenticatedContribution,
    type AuthenticatedContribution,
    type AuthenticatedPackageInstallation,
    type PreparedPackageContribution
} from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { SettingsLayer } from "../../src/facets";
import { MemoryWorkspaceSettingsStore } from "../../src/facets/settings-memory";
import { WorkspaceId } from "../../src/identity";
import { malformed } from "../helpers/malformed";
import { WorkspaceSettingsMaterializer } from "../../src/composition/settings-materializer";
import { layer } from "../w3/settings-store-contract";
import {
    TestPackageInstallationProvenance,
    authenticatedInstallationFixture
} from "../workspaces/fixtures";

const INIT = { ordinal: 0, schema: { type: "object", properties: { level: { type: "string" } } } };

interface Harness {
    readonly materializer: WorkspaceSettingsMaterializer<
        object | undefined,
        unknown,
        object | undefined
    >;
    readonly provenance: TestPackageInstallationProvenance<object> | undefined;
    readonly settings: MemoryWorkspaceSettingsStore;
}

function harness(installation?: AuthenticatedPackageInstallation): Harness {
    const provenance = new TestPackageInstallationProvenance<object>(
        installation ?? authenticatedInstallationFixture("workspace:settings")
    );
    const settings = new MemoryWorkspaceSettingsStore(new WorkspaceId("workspace"));
    return {
        materializer: new WorkspaceSettingsMaterializer(settings, provenance),
        provenance,
        settings
    };
}

/**
 * A provenance double that hands the callback something other than the token the port
 * issued, so the seam's refusal of forged and replayed capabilities is observable.
 */
function interceptingHarness(
    intercept: (issued: AuthenticatedContribution) => AuthenticatedContribution
): Harness {
    class InterceptingProvenance extends PackageInstallationProvenancePort<
        undefined,
        undefined
    > {
        public override withAuthenticatedContribution<Result>(
            state: undefined,
            context: undefined,
            stamp: PreparedPackageContribution["stamp"],
            materialize: (contribution: AuthenticatedContribution) => Result
        ): Result | undefined {
            return super.withAuthenticatedContribution(state, context, stamp, (issued) =>
                materialize(intercept(issued))
            );
        }

        protected override authenticatedInstallation():
            | AuthenticatedPackageInstallation
            | undefined {
            return authenticatedInstallationFixture("workspace:settings");
        }
    }
    const settings = new MemoryWorkspaceSettingsStore(new WorkspaceId("workspace"));
    return {
        materializer: new WorkspaceSettingsMaterializer(settings, new InterceptingProvenance()),
        provenance: undefined,
        settings
    };
}

function preparedFrom(harness: Harness["materializer"]): PreparedPackageContribution {
    const prepared = harness.prepareContribution({}, {});
    if (prepared === undefined) {
        throw new TypeError("Authenticated installation did not prepare a contribution");
    }
    return prepared;
}

function expectAgentCoreError(
    action: () => void,
    code: AgentCoreError["code"],
    message: RegExp
): void {
    try {
        action();
        throw new TypeError("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error.code).toBe(code);
        expect(error.message).toMatch(message);
    }
}

describe("Workspace settings materializer", () => {
    test(
        "[C13-FACET-CONTRIBUTION-ATTRIBUTION] mints the layer's attribution only from the authenticated installation",
        { tags: "p0" },
        () => {
            const installation = authenticatedInstallationFixture("workspace:settings");
            const { materializer, settings } = harness(installation);

            const prepared = preparedFrom(materializer);
            const materialized = materializer.materialize({}, {}, prepared, INIT);

            expect(materialized.attribution.contributor.value).toBe("workspace:settings");
            expect(materialized.attribution.package.equals(installation.package)).toBe(true);
            expect(settings.layers()).toHaveLength(1);
            expect(settings.layers()[0]!.id.equals(materialized.id)).toBe(true);
        }
    );

    test("refuses an input that supplies record state", { tags: "p0" }, () => {
        const { materializer, settings } = harness();

        for (const forged of [
            { ...INIT, contributor: "workspace:other" },
            { ...INIT, package: {} },
            { ...INIT, id: "settings:forged" }
        ]) {
            expect(() =>
                materializer.materialize({}, {}, preparedFrom(materializer), forged)
            ).toThrow(/must not supply record state/);
        }
        expect(settings.layers()).toHaveLength(0);
        expect(settings.revision().value).toBe(0);
    });

    test("fails closed when installation provenance disappears before apply", { tags: "p0" }, () => {
        const { materializer, provenance, settings } = harness();
        const prepared = preparedFrom(materializer);

        provenance!.installation = undefined;

        expectAgentCoreError(
            () => materializer.materialize({}, {}, prepared, INIT),
            "authority.denied",
            /changed before materialization/
        );
        expect(settings.layers()).toHaveLength(0);
        expect(settings.revision().value).toBe(0);
    });

    test(
        "[C13-ADV-ATTRIBUTION] a structurally forged contribution token confers no attribution",
        { tags: "p0" },
        () => {
            const hostile = interceptingHarness(() => malformed<AuthenticatedContribution>({}));

            expectAgentCoreError(
                () => hostile.materializer.materialize({}, {}, preparedFrom(hostile.materializer), INIT),
                "authority.denied",
                /requires authenticated contribution provenance/
            );
            expect(hostile.settings.layers()).toHaveLength(0);
            expect(hostile.settings.revision().value).toBe(0);
        }
    );

    test(
        "[C13-ADV-ATTRIBUTION] a replayed contribution token is refused on its second use",
        { tags: "p0" },
        () => {
            let captured: AuthenticatedContribution | undefined;
            const hostile = interceptingHarness((real) => {
                const stale = captured;
                captured ??= real;
                return stale ?? real;
            });

            // The first span consumes its own freshly issued token and succeeds; the second
            // span replays the already-consumed one.
            hostile.materializer.materialize({}, {}, preparedFrom(hostile.materializer), INIT);
            expect(hostile.settings.layers()).toHaveLength(1);

            expectAgentCoreError(
                () => hostile.materializer.materialize({}, {}, preparedFrom(hostile.materializer), INIT),
                "authority.denied",
                /requires authenticated contribution provenance/
            );
            expect(consumeAuthenticatedContribution(captured!)).toBeUndefined();
            expect(hostile.settings.layers()).toHaveLength(1);
            expect(hostile.settings.revision().value).toBe(1);
        }
    );

    test(
        "[C13-ADV-ATTRIBUTION] unattributed record data cannot decode into a contributed layer",
        { tags: "p0" },
        () => {
            // A direct settings value with no attribution is invalid rather than unattributed.
            expect(() => SettingsLayer.fromData({ ordinal: 0, schema: INIT.schema })).toThrow(
                TypeError
            );
            expect(() => layer("workspace:facet", -1)).toThrow(TypeError);
        }
    );
});
