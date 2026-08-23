import type {
    AuthenticatedContribution,
    PackageInstallationProvenancePort,
    PreparedPackageContribution
} from "../definition";
import { consumeAuthenticatedContribution } from "../definition";
import { AgentCoreError } from "../errors";
import type { FacetData } from "../facets";
import { SettingsLayer } from "../facets";
import type { WorkspaceSettingsStore } from "../facets";

/**
 * What a trusted materialization declares: exactly the manifest-authored fields of one
 * settings contribution. Attribution is never part of it — the record's FacetRef and
 * PackagePin are minted here from the authenticated installation the host is applying,
 * so a direct settings value cannot masquerade as a contributed layer.
 */
export interface SettingsMaterializationInit {
    readonly ordinal: number;
    readonly schema: FacetData;
}

/**
 * Materializes a Facet-contributed settings layer only while the authenticated package
 * installation provenance is current. It never accepts caller-supplied attribution: the
 * sole attributed creation seam consumes the one-use `AuthenticatedContribution` inside
 * the synchronous prepare/apply span, and a forged or already-consumed token has no
 * attribution behind it and refuses instead of writing.
 */
export class WorkspaceSettingsMaterializer<Read, Transaction, Context> {
    public constructor(
        private readonly settings: WorkspaceSettingsStore<Transaction>,
        private readonly provenance: PackageInstallationProvenancePort<Read, Context>
    ) {}

    public prepareContribution(
        read: Read,
        context: Context
    ): PreparedPackageContribution | undefined {
        return this.provenance.prepareContribution(read, context);
    }

    public materialize(
        read: Read,
        context: Context,
        prepared: PreparedPackageContribution,
        init: SettingsMaterializationInit
    ): SettingsLayer {
        if (
            "attribution" in init ||
            "contributor" in init ||
            "id" in init ||
            "origin" in init ||
            "package" in init
        ) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Settings materialization input must not supply record state"
            );
        }
        const layer = this.provenance.withAuthenticatedContribution(
            read,
            context,
            prepared.stamp,
            (contribution) => this.writeAttributedLayer(contribution, init)
        );
        if (layer === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Settings contributor installation provenance changed before materialization"
            );
        }
        return layer;
    }

    private writeAttributedLayer(
        contribution: AuthenticatedContribution,
        init: SettingsMaterializationInit
    ): SettingsLayer {
        const attribution = consumeAuthenticatedContribution(contribution);
        if (attribution === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Settings materialization requires authenticated contribution provenance"
            );
        }
        const layer = new SettingsLayer(attribution, init.ordinal, init.schema);
        this.settings.contribute(layer);
        return layer;
    }
}
