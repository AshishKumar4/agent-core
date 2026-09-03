import { RecordCodec, Revision, isStringArray, type JsonValue, TextId } from "../core";
import { AgentCoreError } from "../errors";
import {
    compareIdentityText,
    invalid,
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import { PrincipalId, TeamId, TenantId } from "./id";

class TeamRecordCodec extends RecordCodec<Team> {
    public constructor() {
        super([Team, Revision, TextId, TeamId, TenantId, PrincipalId], "identity.team", {
            major: 1,
            minor: 0
        });
    }

    protected encodePayload(team: Team): JsonValue {
        return {
            id: team.id.value,
            name: team.name,
            principals: team.principals.map((principal) => principal.value),
            revision: team.revision.value,
            tenant: team.tenantId.value
        };
    }

    protected decodePayload(payload: JsonValue): Team {
        const object = requireIdentityObject(payload, "Team payload");
        requireIdentityFields(
            object,
            ["id", "name", "principals", "revision", "tenant"],
            "Team payload"
        );
        const principals = object["principals"];
        if (!isStringArray(principals)) {
            throw invalid("Team principals must be an array of Principal IDs");
        }
        return new Team(
            new TeamId(requireIdentityString(object["id"], "Team ID")),
            new TenantId(requireIdentityString(object["tenant"], "Team tenant")),
            requireIdentityString(object["name"], "Team name"),
            principals.map((principal) => new PrincipalId(principal)),
            requireIdentityRevision(object["revision"], "Team revision")
        );
    }
}

/** The longest a Team name may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
const MAX_TEAM_NAME_LENGTH = 256;

export class Team {
    public static get codec(): RecordCodec<Team> {
        return teamCodecInstance;
    }
    public readonly name: string;
    public readonly principals: readonly PrincipalId[];

    public constructor(
        public readonly id: TeamId,
        public readonly tenantId: TenantId,
        name: string,
        principals: readonly PrincipalId[],
        public readonly revision: Revision
    ) {
        this.name = requireName(name, "Team name");
        const ordered = [...principals].sort((left, right) =>
            compareIdentityText(left.value, right.value)
        );
        if (new Set(ordered.map((principal) => principal.value)).size !== ordered.length) {
            throw new TypeError("Team principals must be unique");
        }
        this.principals = Object.freeze(ordered);
        Object.freeze(this);
    }

    public static encode(team: Team): Uint8Array {
        return Team.codec.encode(team);
    }

    public static decode(bytes: Uint8Array): Team {
        return Team.codec.decode(bytes);
    }

    public has(principal: PrincipalId): boolean {
        return this.principals.some((candidate) => candidate.equals(principal));
    }

    public revise(name: string, principals: readonly PrincipalId[]): Team {
        if (
            name.trim() !== name ||
            name.length === 0 ||
            name.length > MAX_TEAM_NAME_LENGTH ||
            new Set(principals.map((principal) => principal.value)).size !== principals.length
        ) {
            throw new AgentCoreError("protocol.invalid-state", "Team revision is invalid");
        }
        if (this.revision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError("protocol.invalid-state", "Team revision is exhausted");
        }
        return new Team(this.id, this.tenantId, name, principals, this.revision.next());
    }
}

const teamCodecInstance = new TeamRecordCodec();

function requireName(value: string, subject: string): string {
    if (value.trim() !== value || value.length === 0 || value.length > MAX_TEAM_NAME_LENGTH) {
        throw new TypeError(
            `${subject} must contain between 1 and ${MAX_TEAM_NAME_LENGTH} canonical characters`
        );
    }
    return value;
}
