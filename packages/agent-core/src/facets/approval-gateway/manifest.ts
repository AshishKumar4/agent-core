import type { FacetManifest } from "../manifest";
import {
    createStandardProfileManifest,
    type StandardProfileManifestInit
} from "../profile-runtime";
import { APPROVAL_GATEWAY_CONTRIBUTIONS, APPROVAL_GATEWAY_ISOLATION } from "./facet";

export function createApprovalGatewayManifest(init: StandardProfileManifestInit): FacetManifest {
    return createStandardProfileManifest(init, {
        isolation: APPROVAL_GATEWAY_ISOLATION,
        contributions: APPROVAL_GATEWAY_CONTRIBUTIONS
    });
}
