# Formal Lean 4.33.1 port - lock parity audit

> Edited & maintained by Claude; presented as-is. Generated evidence for the
> toolchain cutover v4.16.0 -> v4.33.1 of packages/agent-core/formal.

Deterministic regeneration: `node scripts/quality/lock-parity-audit.mjs <base> <head>`.
Byte-stable output verified by double run. Full captured JSON follows.

```json
{
  "refs": {
    "base": "/home/mrwhite0racle/agent-core-context/formal-closure/base-normative-v4160.lock",
    "head": "./artifacts/normative.lock"
  },
  "encoding": [
    "agent-core-lean-structure-sourced-closure",
    "agent-core-lean-structure-sourced-closure"
  ],
  "pins": {
    "leanToolchain": [
      "leanprover/lean4:v4.16.0",
      "leanprover/lean4:v4.33.1"
    ],
    "lakeManifestSha256Equal": true
  },
  "allowedAxiomsEqual": true,
  "auditedModulesEqual": true,
  "designations": {
    "counts": [
      632,
      632
    ],
    "added": [],
    "removed": [],
    "setDiffEmpty": true,
    "typeSha256DeltaCount": 10,
    "typeSha256Deltas": [
      "claim:AgentCore.foreign_subject_key_separates_verification_schemes",
      "claim:AgentCore.guest_allow_is_attenuated",
      "claim:AgentCore.guest_deny_is_preserved",
      "claim:AgentCore.stale_mediated_denial_matches_intent",
      "witness:AgentCore.Examples.nonvacuous_canonical_encoding_discriminates",
      "witness:AgentCore.Examples.nonvacuous_canonical_subject_key_separates_schemes",
      "witness:AgentCore.Examples.nonvacuous_glob_covering_admits_narrowing",
      "witness:AgentCore.Examples.nonvacuous_glob_covering_refuses_widening",
      "witness:AgentCore.Examples.nonvacuous_glob_match_discriminates",
      "witness:AgentCore.Examples.nonvacuous_pattern_validity_discriminates"
    ],
    "allowedAxiomsDeltaCount": 97,
    "allowedAxiomsDeltas": [
      {
        "designation": "claim:AgentCore.AuthorityLedger.direct_deadline_cannot_exceed_original_lease",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.acceptance_unsatisfied_not_settled",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.admitted_intent_is_admitted_by_every_ancestor",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.applicable_interceptor_forbids_direct_admission",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.at_most_one_reserving_write_per_identity",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.authorityKey_injective",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.authority_decision_iff_effective",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.authority_decision_is_deny_precedence",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.authority_decision_is_sound",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.authority_grant_matches_deny_iff",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.authority_grant_matches_iff",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.capability_covering_is_complete",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.capability_covering_is_sound",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.capability_matches_iff",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.changed_registry_epoch_blocks_mediated_ready",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.changed_target_fence_cannot_consume",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.commit_unknown_before_consume_preserves_state",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.commit_unknown_before_issue_preserves_state",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.consume_requires_current_fence_and_unexpired",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.consumed_nonce_cannot_be_consumed_again",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.covering_chain_never_widens",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.delivered_reservation_cannot_redeliver",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.delivery_audit_can_cause_commit_locally",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.delivery_commit_matches_route",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.delivery_requires_target_local_projection",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.direct_admission_has_no_applicable_interceptor",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.direct_admission_is_nondurable",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.direct_checks_exact_current_incarnation",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.direct_has_no_durable_side_effect",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.direct_ready_uses_exact_holder_watermark_inequality",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.direct_resolution_uses_actual_lease_expiry",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.foreign_subject_key_separates_verification_schemes",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.globMatch_complete",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.glob_covering_iff_containment",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.guest_deny_is_preserved",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "claim:AgentCore.item_obligation_uses_exact_audit",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.lineage_ok_ancestor_covers",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.materialization_requires_verified_guest",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.mediated_ready_reserves_exact_obligation",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.mediated_ready_validates_exact_run_reservation",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.mediated_rechecks_current_authority_path",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.mediated_without_turn_has_exact_owner_audit",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.mediated_without_turn_uses_owning_actor_path",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.permit_issue_requires_exact_authenticated_binding",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.pre_receipt_id_cannot_be_reused_for_attempt",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.reachable_attempts_have_guarded_admission",
        "gained": [
          "Quot.sound"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.reachable_from_preserves_guarded_attempt_admissions",
        "gained": [
          "Quot.sound"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.reactivation_resolves_commit_unknown",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.rematerialization_advances_epoch",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "claim:AgentCore.reset_preserves_durable_permit_state",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.retry_requires_prior_final_failure",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.routed_mediated_validates_projection_digest",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.scope_key_injective",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.serving_past_commit_unknown_is_branch_dependent",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.session_use_is_turn_owned_and_live",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.settled_has_coherent_snapshot_and_exact_obligations",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.settled_run_acceptance_holds_at_current_head",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.stale_or_fabricated_token_cannot_self",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.stale_session_admits_nothing",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.subject_key_injective",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.supersession_at_most_once",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.synthesis_is_system_controlled_exact_turn",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.system_control_writer_uses_exact_typed_audit",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.terminal_batch_is_derived_not_stored",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.trace_epoch_never_decreases",
        "gained": [
          "Quot.sound"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.unary_commit_inherits_pins",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.undo_requires_unheld_branch_and_ancestor_selection",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "claim:AgentCore.unprojected_reservation_cannot_deliver",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_abandoned_claim_same_ordinal_recovery",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_repeat_verdict_step_rejected",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_verdict_blocks_retry",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_allows_without_matching_deny",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_ancestor_deny_overrides",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_grant_matches_discriminates",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_guest_deny_crosses_schemes",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_guest_elevation_refused",
        "gained": [
          "Classical.choice",
          "Quot.sound"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_lineage_walks_and_refuses",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_encoding_discriminates",
        "gained": [
          "Classical.choice",
          "Quot.sound",
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_key_separates_delimiter_collision",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_scope_key_discriminates",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_subject_key_separates_schemes",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_admits_narrowing",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_matches_discriminates",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_refuses_impact_widening",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_refuses_pattern_escalation",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_validity_holds",
        "gained": [
          "Classical.choice",
          "Quot.sound"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_commit_unknown_before_after_issue",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_covering_chain_reaches_leaf",
        "gained": [
          "Classical.choice",
          "Quot.sound"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_double_reservation_is_inconsistent",
        "gained": [
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_failed_retry",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_foreign_guest_deny",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_glob_covering_admits_narrowing",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_glob_covering_refuses_widening",
        "gained": [
          "Classical.choice"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_glob_match_discriminates",
        "gained": [
          "Classical.choice",
          "Quot.sound",
          "propext"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_malformed_approval_continuation_rejected",
        "gained": [],
        "lost": [
          "Quot.sound"
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_pattern_validity_discriminates",
        "gained": [
          "Classical.choice",
          "Quot.sound"
        ],
        "lost": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_stale_self_rejection",
        "gained": [
          "propext"
        ],
        "lost": []
      }
    ],
    "allAxiomValuesWithinAllowlist": true,
    "outsideAllowlist": [],
    "constructiveToClassicalCount": 48
  },
  "declarations": {
    "counts": [
      2713,
      2791
    ],
    "addedCount": 80,
    "removedCount": 2,
    "removedList": [
      "AgentCore.instDecidableEqAuthorityGrant",
      "AgentCore.instDecidableEqCapability"
    ],
    "sharedNameShaChangedCount": 155
  },
  "closureDeltas": {
    "count": 532,
    "unclassifiedMemberCount": 0,
    "deltas": [
      {
        "designation": "claim:AgentCore.AuthorityLedger.authorized_binding_matches_operation_facet",
        "semanticClosureSha256": [
          "sha256:390e35faf59687e3e443f02964b30020bb00d386ed82927532837cdf54650a13",
          "sha256:13777b6b6f47308c7fa3ef51ec48f9698d210371a3310b010676c87078598c4c"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.AuthorityLedger.bump_scope_stales_path_evidence",
        "semanticClosureSha256": [
          "sha256:729aece76b7c956f6bfb113a9282a771495f48e91ba141a32b85096b8da65aa9",
          "sha256:d59a4d7ad6cf6c39d11c1b6e3a9e2e9356dbdb8ad2120cbea382e39bc24a8cc9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.AuthorityLedger.delegated_allow_is_contained_and_not_wider",
        "semanticClosureSha256": [
          "sha256:b7393d4f25225d9bfbaa464dbd73b93cda455813d154f7c74a5c533c78cdf133",
          "sha256:05f65f7ba9aa705973f30dc9766ce84f89d70abc34cacb341222648f29b00993"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.AuthorityLedger.deny_overrides",
        "semanticClosureSha256": [
          "sha256:390e35faf59687e3e443f02964b30020bb00d386ed82927532837cdf54650a13",
          "sha256:13777b6b6f47308c7fa3ef51ec48f9698d210371a3310b010676c87078598c4c"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.AuthorityLedger.holder_observation_joins_epoch",
        "semanticClosureSha256": [
          "sha256:fd472be86a87354b1ccbb3831fe470d83eb7088e9ffb79c6fa71f9f500751804",
          "sha256:f93057522bd7e7878903717d60e26c36a3e00b1db961112f42f123a1cf61cddd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.AuthorityLedger.resolution_issue_records_authorized_evidence",
        "semanticClosureSha256": [
          "sha256:b7393d4f25225d9bfbaa464dbd73b93cda455813d154f7c74a5c533c78cdf133",
          "sha256:05f65f7ba9aa705973f30dc9766ce84f89d70abc34cacb341222648f29b00993"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.InvocationPayload.arguments_nonempty",
        "semanticClosureSha256": [
          "sha256:94f697b6b683a710a33c5d3b80a19bc67f1cbcf2c39314200f314fe200af0a1d",
          "sha256:cd7b2f048645e3da22d58fd0262ab85fc94b557d9fddc9d3b580ecb6707d1874"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.Representation.Broker.apply_action_gate",
        "semanticClosureSha256": [
          "sha256:8de35f56a8fe0221a9a849d5eac3ad7a004e5cde18f4d3ce6477b3f8e16aaede",
          "sha256:4ea8e6b75dfb3ebbf888aa2cdd739d15d6cd603ee2d3ce978187fc9846109cd2"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.Representation.Broker.consumed_action_never_refires",
        "semanticClosureSha256": [
          "sha256:8de35f56a8fe0221a9a849d5eac3ad7a004e5cde18f4d3ce6477b3f8e16aaede",
          "sha256:4ea8e6b75dfb3ebbf888aa2cdd739d15d6cd603ee2d3ce978187fc9846109cd2"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.Representation.Broker.expired_action_never_fires",
        "semanticClosureSha256": [
          "sha256:8de35f56a8fe0221a9a849d5eac3ad7a004e5cde18f4d3ce6477b3f8e16aaede",
          "sha256:4ea8e6b75dfb3ebbf888aa2cdd739d15d6cd603ee2d3ce978187fc9846109cd2"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.Representation.Broker.initial_custody",
        "semanticClosureSha256": [
          "sha256:ea8e0dc4c97c163f24895ba38e6e14359ee761ec24d14680d4007ce8760019c9",
          "sha256:cda560cb886556b7db168693b99fb6ed5256613f0ab7a3f6591a988abedc266c"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.Representation.Broker.reachable_custody",
        "semanticClosureSha256": [
          "sha256:167318ddb4195dfc9ec733a55f883a035439988fb26c40f156f4282c135ca51b",
          "sha256:bd85fdeaab7dfd30e9e8389e3e14d1e2df17b0a0d0307c416f8dc2e85db867f5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.Representation.Broker.step_preserves_custody",
        "semanticClosureSha256": [
          "sha256:eb14a6a98d218ed2be51acd2c01d0be198d9d0c669b414cdadb31da8f02d2dac",
          "sha256:9f7965911b8d2d934511de68170b3c04444f481a00828fb6426a52c0d55f24e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.Representation.Broker.tampered_action_never_fires",
        "semanticClosureSha256": [
          "sha256:8de35f56a8fe0221a9a849d5eac3ad7a004e5cde18f4d3ce6477b3f8e16aaede",
          "sha256:4ea8e6b75dfb3ebbf888aa2cdd739d15d6cd603ee2d3ce978187fc9846109cd2"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.Representation.Consent.revoke_blocks",
        "semanticClosureSha256": [
          "sha256:5c1b4537782266d24dea4db1e2994888a2b2862c4746c9e7499961660392a13f",
          "sha256:064dee6b0a246ce178c3d6ea24c44dfde540fd0b1469f53f1ba7ca648fa70d89"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.Representation.Consent.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.Representation.Consent.instDecidableEqDeviceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.Representation.Consent.instDecidableEqPair.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.Representation.Reaction.reaction_at_most_once",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.Representation.Reaction.reaction_consumes_key",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.Representation.Reaction.reaction_targets_declared",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.Representation.Reaction.reaction_trust_is_channel_derived",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.abandoned_claim_recovery_preserves_ordinal_without_attempt",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.abort_discards_every_staged_write",
        "semanticClosureSha256": [
          "sha256:4da7e48126024b676f834554daba7b907d28e05c1a3f6f839441783cc3bb74fe",
          "sha256:ea9bd8c939e31e2cb02e4817f91b6093718e0510fcb0576b9fb4b6696b187864"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.acceptance_unsatisfied_not_settled",
        "semanticClosureSha256": [
          "sha256:f256eb0378e88be856ad5531b309a5b2144ea81ea9059fad5e2699d5ce9e8168",
          "sha256:94f56a94568c1f807855fd539ecbdabb295b68bcb2df6a81ac7ddecfc456fa2d"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.acceptance_verdict_step_requires_declared_verifier_receipt",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.accepted_self_has_live_exact_lease",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.activation_advances_the_epoch",
        "semanticClosureSha256": [
          "sha256:725decdbaca6ca913f1c7a0a889c622acd5d4a832b817866b52cc20f042569ba",
          "sha256:4f68aa61dcdafbab3e086496fd714cc5c5c29e0db0f25dba4937bc0fa249d17d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.activation_refuses_a_foreign_actor",
        "semanticClosureSha256": [
          "sha256:791fb06370dd2aee8ae0752756da0245c9e28fb49a32d9ac7c7d4960b833e073",
          "sha256:7986abab504829075039c380ec4676eb3c2a19a256c028581948091fc9485a8a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.admitted_intent_is_admitted_by_every_ancestor",
        "semanticClosureSha256": [
          "sha256:ae95af02fdce1f840962744ec62d19c14cbdbfac65db80bc5b35f00bcdc5ff3d",
          "sha256:01c448bc7acb2475b77d380d84167ac578d90c09bc008e93b073dc95c2a305c0"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.allow_requires_exact_verification_scheme",
        "semanticClosureSha256": [
          "sha256:49e063d5e2e4036af5482c88a21689022ae0f395d3ff73c619fdb5a516a82792",
          "sha256:c817b2a65b4c50a5da8faf1bffba18b36931a300716c05eb4d4735f7da285bb3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.already_materialized_template_cannot_rematerialize",
        "semanticClosureSha256": [
          "sha256:0eb261f7c8ac6f505a909321ecb43b5ac6a423ac380c67711da789bb273b1abb",
          "sha256:4e53b7092bbc3914910d40ccc376a27b1f519e44826a30636e8653b212abc2f2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBlueprintId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionTemplateName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.ancestor_deny_defeats_descendant_allow",
        "semanticClosureSha256": [
          "sha256:24ebdeeeb4331d559d6ae5927822b701fb172d0b73b54aa9b0c2a5b5995a3d01",
          "sha256:9c8d3201b848ba702c1e26593ff489010800a347167d118e43b9fa49b40c232b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.applicable_interceptor_forbids_direct_admission",
        "semanticClosureSha256": [
          "sha256:bdaeed18b70032cdd9e9b37fd5bcadc395cb403154878e5b78eb6a5e38a3dc4f",
          "sha256:049f10717ac76164734e5fbbeadeba31d691bb96d3a8522133a53ba28f6fce6e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.applyWrites_journal_extends",
        "semanticClosureSha256": [
          "sha256:652b83fe09ac5915aae07eff0ba7b43b5e6e187ff863a5f9dd01eeaf46ca9d39",
          "sha256:102145ce645304d04d80a304a7a1899841d1fb2069e6b6a0e6b2a1ea7f627fdf"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.applyWrites_preserve_recoveries",
        "semanticClosureSha256": [
          "sha256:652b83fe09ac5915aae07eff0ba7b43b5e6e187ff863a5f9dd01eeaf46ca9d39",
          "sha256:102145ce645304d04d80a304a7a1899841d1fb2069e6b6a0e6b2a1ea7f627fdf"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.approval_admission_requires_reserved_obligation",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.approval_available_binds_authority_principal",
        "semanticClosureSha256": [
          "sha256:caab3cab805c2caf33dbae0f4d646e6ac1fdbc90ff64312bcc309920b0232bb7",
          "sha256:166f40d690a5e17406e39bf7417f471342fe98f1589e6f93613007f580d19486"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.approval_available_has_no_continuation",
        "semanticClosureSha256": [
          "sha256:e2d8dcc2edd322231d57eb15db5076e80eccf91890cb0b6ee6899ef076b7b8d7",
          "sha256:545282cf35b526be607ebd9c47d678155da382875b608a84562f1f53e37c1517"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.approval_available_is_exact",
        "semanticClosureSha256": [
          "sha256:e2d8dcc2edd322231d57eb15db5076e80eccf91890cb0b6ee6899ef076b7b8d7",
          "sha256:545282cf35b526be607ebd9c47d678155da382875b608a84562f1f53e37c1517"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.approval_continuation_is_exact",
        "semanticClosureSha256": [
          "sha256:8987c5bcea28b39bda67e17c68dbf66c70bd80de30601426dbbec17dccff4667",
          "sha256:da712f16861f8043a02f5a22cf7925518ac5832aba9147d476a155c77957536a"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.approval_continuation_validates_persisted_exact_intent",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.approval_start_consumes_persisted_exact_intent",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.approved_attempt_and_exact_audit_are_one_transition",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.approved_effect_admission_requires_reserved_item",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.approved_execution_uses_persisted_identity",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.asserted_tier_publish_rejected",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.attempt_receipt_and_exact_audit_are_one_transition",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.audit_append_is_locally_acyclic",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.audit_sequence_is_unique",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.audit_step_establishes_causal_chain",
        "semanticClosureSha256": [
          "sha256:03c29fc381a009a9d7d2a5302306e8fb9f9b04891b522132319fc717d5fb6edb",
          "sha256:52cc1e8602b802fdd0f6df463195fa6f8c3c85a6866323ed5cc35395d5ce8753"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authentication_requires_exact_target_request",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authorityKey_injective",
        "semanticClosureSha256": [
          "sha256:152ece5d4257d426a385b66ee98f14858d1f8e599359bdb58f31ccd6a22b9b67",
          "sha256:2a6e8bc85b1fc8ee27412e7d2fe7bdcb6161eca90ac92a682a09254cd678d6f6"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.authority_decision_iff_effective",
        "semanticClosureSha256": [
          "sha256:5e630e5cacee16d563ff612636d3a81f39a34f7d00b377e4ee9d4fbff662eeb7",
          "sha256:769acb11106deb7fc82ee562ed99c184cb5ffb807aa471100bd7a94ac1a87b0e"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authority_decision_is_deny_precedence",
        "semanticClosureSha256": [
          "sha256:f8a9f727212f55322f7b460ec1921a72a3a1b29e1de9f72b92bb62598f7dc475",
          "sha256:53a5f895aa7dae212a4443d49d48a2ca8a31d92a6e905c7d5f1c301a39e1a022"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authority_decision_is_sound",
        "semanticClosureSha256": [
          "sha256:a1e191ecaf240eea906e6394bb9e50ca813462c7b722556ef6637e2c1b821dd6",
          "sha256:329a55bbf1ca18dd1d6e6523e21da89008f0d8d14064b847db5786885c72c06d"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authority_grant_matches_deny_iff",
        "semanticClosureSha256": [
          "sha256:ecb0e7bcef3ea8c78f1a46f9861432c994378570c173d4d5343bd745a1bfd3f7",
          "sha256:68ff672d5d1948f60666993f95911847aea96b3b6116260bb01c3c0ffffbdf88"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authority_grant_matches_iff",
        "semanticClosureSha256": [
          "sha256:770ec63dce4df4ee6d935d02d01a2fc21b4e315c5a953bcde6f72436452672e9",
          "sha256:62fc2e97bffee8c17cc492ce11720dabc8c9d816af33763230101aa4ae485e8b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authorized_contribution_carries_admission",
        "semanticClosureSha256": [
          "sha256:d00f35fc5b0d0b197dd676c0416f4f6b87d0c62dc775aeaae8db26f7ab347390",
          "sha256:aa07cb381efbc1ff2d6c10963c21d0089d8c7edf45fbb131ace57d348c9fa0d9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.authorized_slot_step_is_slot_step",
        "semanticClosureSha256": [
          "sha256:d00f35fc5b0d0b197dd676c0416f4f6b87d0c62dc775aeaae8db26f7ab347390",
          "sha256:aa07cb381efbc1ff2d6c10963c21d0089d8c7edf45fbb131ace57d348c9fa0d9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.bind_without_activation_faults_the_next_activation",
        "semanticClosureSha256": [
          "sha256:1c293b879f957f05903ebf97ec0fd8dbb16aa4766b41e0de0d8c6367b8409d94",
          "sha256:2242a7efd1e55ab408c7012e993db1b87e6c369a5219bd83273a0c55aeb29cbd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.canonical_encode_injective",
        "semanticClosureSha256": [
          "sha256:9940bdd71afbb713709abb2877a1259db72426de48bfdbc8ccebedd9d7409cdb",
          "sha256:8aa59fe24b8ef3e3b6db9a61bb023165fef74d481363a8eaf0f0372eac9f24ac"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.capability_covering_is_complete",
        "semanticClosureSha256": [
          "sha256:785d647cccd6b10a8c174ce0500da74ca152161638f4bf0d7d9f6b300797d44c",
          "sha256:3bd3d0311222324a3c8b67883b75604193f7d6a30154a758535f776938a52327"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.capability_covering_is_sound",
        "semanticClosureSha256": [
          "sha256:6b327657002df41951ecdf26ff7ec0fb89a21f7a8385f586bfafac8e22151b65",
          "sha256:bf93bf40b93dfb48c016f66af3f42760b4417582b5c58ec2a77622cb8d49a500"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.capability_matches_iff",
        "semanticClosureSha256": [
          "sha256:e7a9c13c7ebb4e0e07717e1792b9a0fc6cd281a428fefe580e8d90f5af14e65d",
          "sha256:91182127fc794798bc72fb43768d2fa4b6a07c578c089c5c5a6d3b1756415e85"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.causal_chain_preserved_by_step",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.changed_registry_epoch_blocks_mediated_ready",
        "semanticClosureSha256": [
          "sha256:ab908faf689b93f74f6db7ae5c62f358774833a3805e1b65ed9dfc7557f3a7cb",
          "sha256:d16e9366f57ca23f36c70cd4ab71d8fb2c8c63cedbe73bca4a0e0d024a82a865"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.changed_target_fence_cannot_consume",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.claim_records_future_expiry",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.claim_uses_exact_prepared_owner",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.close_disposes_child_facets",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.closed_incarnation_admits_no_command",
        "semanticClosureSha256": [
          "sha256:c225e731d4c8b25e34ed49c241e1e191eb5c5f79bffda150e86627dde2d75974",
          "sha256:c7df40c5961ee3c5f5f81aa0263555c5a7a174076ce42576696fa9716cbb2968"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.closed_session_is_terminal",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.collect_requires_unowned",
        "semanticClosureSha256": [
          "sha256:853f2715933abedf004a27e0db8b832aba47ab64526f182f2a445c8412cc2ccc",
          "sha256:7fefed63c4d6759f0f2e9b073463aa05008315ee0ccc1dae8e78adb0b8303377"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.collected_owned_content_is_unreachable",
        "semanticClosureSha256": [
          "sha256:bd18da1a0398a166c73638f22592dbc6ae101917446ddc2f8e85fba811dad212",
          "sha256:3bc6ed973afb962e870a4d0dd0b2ef34e57b72818362b92a392ffe36c93a8fd3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.command_reinstallation_is_stored_identity",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.command_step_preserves_installed_mapping_safety",
        "semanticClosureSha256": [
          "sha256:d14a6c4b88d0d6788725f7a6ff91ba3c6c5c1bbac942aa2cd9d676e3cd2782b0",
          "sha256:fd5ea2e89ee94df9383915293ee3047133199ac2ae999d24d2c4a25a8ecba44d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.command_step_preserves_surface_registration",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.command_surface_collision_rejected",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.commit_applies_exactly_the_staged_writes",
        "semanticClosureSha256": [
          "sha256:c225e731d4c8b25e34ed49c241e1e191eb5c5f79bffda150e86627dde2d75974",
          "sha256:c7df40c5961ee3c5f5f81aa0263555c5a7a174076ce42576696fa9716cbb2968"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.commit_requires_unreserved_identity",
        "semanticClosureSha256": [
          "sha256:041606cbe659d5a33d6253c127a5ccc35a7980ae4a4f007f688362fc1de5c3d4",
          "sha256:69145bf3722be594c8e7d545ba5526dadf6478c6c912fdda5060f1b5ae3b40d6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.commit_unknown_after_consume_persists_attempt_and_consumption",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.commit_unknown_after_issue_persists_exact_record",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.commit_unknown_before_consume_preserves_state",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.commit_unknown_before_issue_preserves_state",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.commit_unknown_closes_the_incarnation",
        "semanticClosureSha256": [
          "sha256:c225e731d4c8b25e34ed49c241e1e191eb5c5f79bffda150e86627dde2d75974",
          "sha256:c7df40c5961ee3c5f5f81aa0263555c5a7a174076ce42576696fa9716cbb2968"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.committed_version_is_immutable",
        "semanticClosureSha256": [
          "sha256:2342a631c36814609728a0c081c0a29f6ca31464659e5e04e0de2d5f4059e913",
          "sha256:8af584349da6a08cd149333c15f3213d5152c79e86921bf787697278743c24e0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlateDeploymentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePreviewId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePublicationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateVersionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.completed_obligation_is_reserved",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.completed_runs_assemble_valid_replay_item",
        "semanticClosureSha256": [
          "sha256:8488475c3a661e3fc8b4db293e0d8a8668d08bd68737cc156c6af47f31661854",
          "sha256:22de0d8c75c39af0f16fc42f6eed71c2cc79379fe5ac9b41984e01c8d5cd31c1"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.conflicting_origin_contribution_rejected",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.consume_is_exact_requested_authenticated_and_atomic",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.consume_requires_current_fence_and_unexpired",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.consumed_approval_unavailable",
        "semanticClosureSha256": [
          "sha256:e2d8dcc2edd322231d57eb15db5076e80eccf91890cb0b6ee6899ef076b7b8d7",
          "sha256:545282cf35b526be607ebd9c47d678155da382875b608a84562f1f53e37c1517"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.consumed_is_monotone",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.consumed_key_never_refires",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.consumed_nonce_cannot_be_consumed_again",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.content_resolution_requires_home_or_grant",
        "semanticClosureSha256": [
          "sha256:853f2715933abedf004a27e0db8b832aba47ab64526f182f2a445c8412cc2ccc",
          "sha256:7fefed63c4d6759f0f2e9b073463aa05008315ee0ccc1dae8e78adb0b8303377"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.content_step_preserves_owned_implies_stored",
        "semanticClosureSha256": [
          "sha256:d3e2911536f226625c8bd697f8c298e5ab0425d1ec403effea0dcc03e79ac0a2",
          "sha256:a3740ee312a3c6154af9a611210cc1e38d3c42a4c89415f33bbec6cd82da2e16"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.continued_attempt_and_exact_audit_are_one_transition",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.continued_effect_admission_requires_reserved_item",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.covering_chain_never_widens",
        "semanticClosureSha256": [
          "sha256:5aeea64da950c878ce308b8c7f69f145cbbdd1f6ed9b4bd640cb893734aa0779",
          "sha256:b389caf068da6c13dfbc7dec4c2766b84a5642221705289d1e2b537ac5a29297"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.cross_tenant_reservation_value_carrier_is_unreachable",
        "semanticClosureSha256": [
          "sha256:9abf81b1d44f09e65169d4622275a521c8ca1f2e765b318581d5c12b36aa72fe",
          "sha256:cb536efb43ff92f7d586d3be978b05d3ae9d1d892addf239605e77217648e6c0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.default_derived_subscription_excludes_external",
        "semanticClosureSha256": [
          "sha256:50f0b02e37dd9d74942447b1d6c8f3f3b08cfef8e5e33d2536100b71f425c0c7",
          "sha256:e379a9e7da4a2f48ebc007409ba1fa337f7b1da8e9ae3aa89725ea5fdea15ba0"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.delivered_reservation_cannot_redeliver",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.delivery_commit_matches_route",
        "semanticClosureSha256": [
          "sha256:5efa4625ff5a4c0a0bdcf84cd6b1b66e76cbae6ef44d9da7b8d89c8d7fdc6580",
          "sha256:9f0d05691a14547a40ed98b715f95d4cc4b0c01f8a4ef13663e57107bd031aa7"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.delivery_planes_name_one_projection",
        "semanticClosureSha256": [
          "sha256:94efc71c53f3b53ed95dd187624a0a4c713972040d68a69600f95c7b9663c88f",
          "sha256:06627e7eda935cc26776e2c7ae433f3c39b75f32df2b76b12ca1a69ae7c6bdeb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.delivery_requires_target_local_projection",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.deny_survives_verification_scheme_change",
        "semanticClosureSha256": [
          "sha256:24ebdeeeb4331d559d6ae5927822b701fb172d0b73b54aa9b0c2a5b5995a3d01",
          "sha256:9c8d3201b848ba702c1e26593ff489010800a347167d118e43b9fa49b40c232b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.deriveSubscription_matches_derived_route",
        "semanticClosureSha256": [
          "sha256:17ab722e573f75eaab4f915459d666eb4249536bd3bdd89885b9490d518fa38f",
          "sha256:ad0fa252c8f5d8bd9aa47d59cec3fc371e8f948dfbd9383dfd5d6f9327c0aae6"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.direct_admission_has_no_applicable_interceptor",
        "semanticClosureSha256": [
          "sha256:bdaeed18b70032cdd9e9b37fd5bcadc395cb403154878e5b78eb6a5e38a3dc4f",
          "sha256:049f10717ac76164734e5fbbeadeba31d691bb96d3a8522133a53ba28f6fce6e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.direct_admission_is_nondurable",
        "semanticClosureSha256": [
          "sha256:bdaeed18b70032cdd9e9b37fd5bcadc395cb403154878e5b78eb6a5e38a3dc4f",
          "sha256:049f10717ac76164734e5fbbeadeba31d691bb96d3a8522133a53ba28f6fce6e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.direct_checks_exact_current_incarnation",
        "semanticClosureSha256": [
          "sha256:df4c4be1d668e145d39ae85eab974633bdcdbd177fa934f0299e82b10391ed37",
          "sha256:7e50d06023c6f74e54ee6339d0b6bfe2a4dc5e07c112eb4cf827012142fed8fa"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.direct_execute_requires_bundled_colocation",
        "semanticClosureSha256": [
          "sha256:de0c4f07ed4e4555fc88dc42800c0ab3d48cae6157d7cccb558ac7e11c4ab5bb",
          "sha256:69183379fff0ecb0b4faa5bebcddcd8d61458c11146449622aebdbc854f94f78"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.direct_has_no_durable_side_effect",
        "semanticClosureSha256": [
          "sha256:bdaeed18b70032cdd9e9b37fd5bcadc395cb403154878e5b78eb6a5e38a3dc4f",
          "sha256:049f10717ac76164734e5fbbeadeba31d691bb96d3a8522133a53ba28f6fce6e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.direct_ready_uses_exact_holder_watermark_inequality",
        "semanticClosureSha256": [
          "sha256:df4c4be1d668e145d39ae85eab974633bdcdbd177fa934f0299e82b10391ed37",
          "sha256:7e50d06023c6f74e54ee6339d0b6bfe2a4dc5e07c112eb4cf827012142fed8fa"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.direct_resolution_uses_actual_lease_expiry",
        "semanticClosureSha256": [
          "sha256:df4c4be1d668e145d39ae85eab974633bdcdbd177fa934f0299e82b10391ed37",
          "sha256:7e50d06023c6f74e54ee6339d0b6bfe2a4dc5e07c112eb4cf827012142fed8fa"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.disable_retains_consumed",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.disabled_never_fires",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.dispatchExec_complete",
        "semanticClosureSha256": [
          "sha256:012b0dcad5fbdf7b010c6427f3831179e337ab239b4dac9d13ac97250a031887",
          "sha256:44acd6345a60208f225c0bd876ce43621dabb1a3b4b7df3c042161e2294fde78"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.dispatchExec_sound",
        "semanticClosureSha256": [
          "sha256:012b0dcad5fbdf7b010c6427f3831179e337ab239b4dac9d13ac97250a031887",
          "sha256:44acd6345a60208f225c0bd876ce43621dabb1a3b4b7df3c042161e2294fde78"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.dispatch_appends_exactly_one_linked_write_and_audit",
        "semanticClosureSha256": [
          "sha256:3a0b1ba7294b9c615b002804cec2ad0f6ce2c47d96bc283837b542b66cb835b6",
          "sha256:e2664e39187eda43bd7e0b9681f35391297841523a504080f3ac748121527f1d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.dispatch_commit_passed_every_gate",
        "semanticClosureSha256": [
          "sha256:7c3bf8e8df7b526b7c410d8b92486cbb9e7daed486bc802016da7dfb12ca89c3",
          "sha256:cdaa039638afbd8f077dce55e72bcca4d7434fd14d87681c60d68d31c5e5282f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.dispatch_duplicate_never_mutates",
        "semanticClosureSha256": [
          "sha256:7c3bf8e8df7b526b7c410d8b92486cbb9e7daed486bc802016da7dfb12ca89c3",
          "sha256:cdaa039638afbd8f077dce55e72bcca4d7434fd14d87681c60d68d31c5e5282f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.dispatch_nonmutating_outcome_preserves_domain",
        "semanticClosureSha256": [
          "sha256:7c3bf8e8df7b526b7c410d8b92486cbb9e7daed486bc802016da7dfb12ca89c3",
          "sha256:cdaa039638afbd8f077dce55e72bcca4d7434fd14d87681c60d68d31c5e5282f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.dispatch_reserved_identity_only_duplicates",
        "semanticClosureSha256": [
          "sha256:7c3bf8e8df7b526b7c410d8b92486cbb9e7daed486bc802016da7dfb12ca89c3",
          "sha256:cdaa039638afbd8f077dce55e72bcca4d7434fd14d87681c60d68d31c5e5282f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.duplicate_cites_reserving_original",
        "semanticClosureSha256": [
          "sha256:7a41396f0b02106d446cd9f59128acd486adbe8f88fa4a1cf96b423650b0d88e",
          "sha256:0a7f8ad586709a44853dcad23ab39daaf7130dcffebe5f5e09b1b5aaf2a18dfd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.duplicate_submission_reserves_and_emits_nothing",
        "semanticClosureSha256": [
          "sha256:041606cbe659d5a33d6253c127a5ccc35a7980ae4a4f007f688362fc1de5c3d4",
          "sha256:69145bf3722be594c8e7d545ba5526dadf6478c6c912fdda5060f1b5ae3b40d6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.durable_state_refines_the_atomic_actor",
        "semanticClosureSha256": [
          "sha256:2634f7c54d39ddf23f1a43ea4fe0d19b1bc039352ce222c772bafb6a59fa140c",
          "sha256:5ed976b21c1e0816f8231c36df0894176b229dd0ecf6a84c4893900f44103c09"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.effect_step_preserves_receipt_id_disjointness",
        "semanticClosureSha256": [
          "sha256:264d18e2d600b49cbc39cdc9d9912f68766001d3cc46a26d92ba832690d33c0d",
          "sha256:ceaaecf5f5f723d19c68206f7a3f1211c4f137404fb4a73d89b361ce555a63e5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.empty_trust_installation_rejected",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.encodeJson_not_delimited",
        "semanticClosureSha256": [
          "sha256:79aab07486543313950da4a30cd122dcf4d53f6d66aa7bab30b8addbf2855c55",
          "sha256:3167ad387c0b8a9cd5f4dbe7903fd5f38a7a5813c03bfe8246e7841f2f76cd93"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.entry_id_reuse_rejected",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.env_step_preserves_credential_isolation",
        "semanticClosureSha256": [
          "sha256:28b29d5f44dc0ef80cf78f3d8096666d00b40c165aad9d5939b0e09934197cce",
          "sha256:b9d71eccd1bc40db3a252d843a3694db7208f7ee240bf329b4fe942b5450f3eb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.event_step_preserves_deliveries",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.event_step_preserves_reservation_for_consistency",
        "semanticClosureSha256": [
          "sha256:c93553a7c6f0ddf6b207897b372dd24c781072c022d84fb19ef7dc29182db691",
          "sha256:d0e9f572e711ae1f076790e9364a35c34fca5c9b7baf899fe16f9a8d6f4a1015"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.every_audited_effect_evidence_matches",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.expired_permit_cannot_consume",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.fire_admits_channel_trust",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.fire_consumes_key",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.fire_is_tenant_contained",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.fire_targets_declared",
        "semanticClosureSha256": [
          "sha256:779dbd22ec4f72856e18ac8169b0f23d813b52954aa10765cf07e57b0d236ede",
          "sha256:80948be75cda79d1b5429ac8357a945bbd23cc9a915c3addea924daffad469e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.first_attempt_and_exact_audit_are_one_transition",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.first_attempt_receipt_clears_only_final_claim",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.first_attempt_uses_exact_current_claim",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.forced_cancellation_is_system_fence",
        "semanticClosureSha256": [
          "sha256:2ec45ca49483dead48d1f9ca273de7490ec2d700b052f317a865fb2645fbf43a",
          "sha256:f27f1791096e9aa0511be262f9b4fa356c2372f384f8f713f7036d91e1e972b0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.forced_cancellation_unblocks_undo",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.foreign_subject_key_separates_verification_schemes",
        "semanticClosureSha256": [
          "sha256:15f9d0f4c7a9e2ba8806ddf6ce1bce6396e2e9fb8be8a92482be236174f2f4e3",
          "sha256:f6683df2eb31462f7127b45ec29451e4c063e8e88734fe0d1c1eebdc9ac7a204"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.foreign_tenant_content_resolution_rejected",
        "semanticClosureSha256": [
          "sha256:853f2715933abedf004a27e0db8b832aba47ab64526f182f2a445c8412cc2ccc",
          "sha256:7fefed63c4d6759f0f2e9b073463aa05008315ee0ccc1dae8e78adb0b8303377"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.foreign_tenant_secret_resolution_rejected",
        "semanticClosureSha256": [
          "sha256:bd189ac669e86364c94d318117cfd9f7de2e151d406d379ffeb7462c16472065",
          "sha256:6ef225badd74de971ec5d155950aba796e9fd6c9f3d62bea8c34c9c788223cae"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.fresh_dynamic_isolate_admits_only_host_pass",
        "semanticClosureSha256": [
          "sha256:4849fb3eb9c75a15f23af096a7442775f68e207eb794bac97b262055197050fa",
          "sha256:4a9d7c8d62fe4fbb37114294043092f5c744c8865681e05ac9f99df86397ee72"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.fresh_resolution_is_current",
        "semanticClosureSha256": [
          "sha256:b1627e867da1bd92259b09047f0dee1688cba407a2b5efb555184934faac6a52",
          "sha256:b8bae36cb9a658c20c6fdc60dbf22359593c598e89fd7c6f59b646f34c368351"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.generic_completion_refuses_acceptance",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.generic_reservation_refuses_acceptance",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.globMatch_complete",
        "semanticClosureSha256": [
          "sha256:eb4baeac9c9a9ff91ee68325a81665c1571d2062335f66ccdaa32beb142cca67",
          "sha256:b8bed9f39a050e3cca31f0b44ee51e0f2f756bb55e534a0710d00906e02a808e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.globMatch_sound",
        "semanticClosureSha256": [
          "sha256:eb4baeac9c9a9ff91ee68325a81665c1571d2062335f66ccdaa32beb142cca67",
          "sha256:b8bed9f39a050e3cca31f0b44ee51e0f2f756bb55e534a0710d00906e02a808e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.glob_covering_iff_containment",
        "semanticClosureSha256": [
          "sha256:5c1c2616808a9d6561d84b99935390fb9d8890dd41b808b91a46c7567c1195b2",
          "sha256:e3fdccfb45bc1c028e3285a8123d59c8ebce757500ca846b7565bb26378bc071"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.graph_reachable_preserves_acceptance_criteria_unique",
        "semanticClosureSha256": [
          "sha256:fbeec45977bb8afac07170ea50edabaf976c99dd92723c88fed3856cfb4f7e79",
          "sha256:79fb40f317735fa59a2822a912d9821fbd7acd3bebd0aafda8b2546dcd54b039"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_reachable_preserves_acceptance_outstanding",
        "semanticClosureSha256": [
          "sha256:0951a63e05c2a3539079ccf97230f563e149ff13597586b490da11b65b937aca",
          "sha256:302a147d5dde6eb1fb130c2c36a70880c97d73f354bddb17e6e0bb9871254685"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_reachable_preserves_commits",
        "semanticClosureSha256": [
          "sha256:ef1c94d21c21633171c52cc673187cd2fe72d42cfa539a1b88011e2ac78234d0",
          "sha256:f171f72e84099b0b1eb1f750f00d372631120108981ca93de822d2b338a6a0c0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_reachable_preserves_earned_verdicts",
        "semanticClosureSha256": [
          "sha256:c541f559713b44eefe213c2377a07e0a3e9f492fba0816d5d150e8a9d0ea0be9",
          "sha256:ce4ef454490de5183c9d1d487cd8388c8f4c3a98edacb087486206fcfd5937c0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_reachable_preserves_snapshot_registry_agreement",
        "semanticClosureSha256": [
          "sha256:86a4abf958f63bf19905b996ba0db8a677bbc986ab3a18b3e306a1272dc882b1",
          "sha256:a7300779aa48b31e66242c801fcbd83ecf5148a8b1f2c882ee5a9527f6af1ccf"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_reachable_settled_acceptance_holds_at_current_head",
        "semanticClosureSha256": [
          "sha256:1848431b356bdc1382d988afa7268ef465a3d6f0726b47f2b63583f7238befda",
          "sha256:8f1ece0d3a85324c40377eb1bd03b648439927841bc2de7b5fa9d0e6bc2e3de6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_step_advances_registries",
        "semanticClosureSha256": [
          "sha256:2fb9e0711d9ebd58d9e14433a57e535248412c4f41a4804ae30b7ec6e9fa4737",
          "sha256:adf527616a8c37a7fa09dad50a22e4814c3dff6df2b1f4635e1185b2e72f62e5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_step_preserves_acceptance_criteria_unique",
        "semanticClosureSha256": [
          "sha256:aa8b51f308a69b0e2e1de48212bf76e744b6bd75aac52f404026042865545d9c",
          "sha256:768b3cc094079543aafcfccd80df743c6166a9ae106a93165bc7d7bb550b17b6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_step_preserves_acceptance_outstanding",
        "semanticClosureSha256": [
          "sha256:3d540abf22d35111a7b32cc1ed14cfbd9fdc3ec98d68db50c2426ac15277720c",
          "sha256:f24a9418d1bc8ac0b7ea17758871c4a268551135b8eb990ae162649524fa16ff"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_step_preserves_commits",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_step_preserves_earned_verdicts",
        "semanticClosureSha256": [
          "sha256:6fbda2b874253a545a82ac293d692dd16cef3b604c679b9e6514290b4959c961",
          "sha256:becaead6f66fc3d5ccd0a4dd57cca326c5719d5a392cfc196e21aa2d97f3ca4e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.graph_step_preserves_snapshot_registry_agreement",
        "semanticClosureSha256": [
          "sha256:14d8d80018718837615dc9f9d81d606909a03d5fcdfb097b9e83d5d517b9e6bc",
          "sha256:5522e3d6621c5495bea3e173f91be163c216692cf29600c0cddf1463d35607b3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.guest_allow_is_attenuated",
        "semanticClosureSha256": [
          "sha256:c1a69d8e1edc21ae239e706cf35d72959c7fc388e11b99209369468fde978cee",
          "sha256:0b12179d1eac9bde51dd13b805280d8d1fb9898b84c3e68976a7ee710f40d0fa"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.guest_deny_is_preserved",
        "semanticClosureSha256": [
          "sha256:c1a69d8e1edc21ae239e706cf35d72959c7fc388e11b99209369468fde978cee",
          "sha256:0b12179d1eac9bde51dd13b805280d8d1fb9898b84c3e68976a7ee710f40d0fa"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.guest_elevation_is_refused",
        "semanticClosureSha256": [
          "sha256:39e611a302f58ff0cd8c7cd07f06d90510f4825fa66943ad726042431d4c3e3d",
          "sha256:d5cd0b21cc1aa766bffae880003d0b483fcbbfb2a5cf63baa932f81bf359d4a1"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.guest_grant_value_carrier_is_unreachable",
        "semanticClosureSha256": [
          "sha256:9abf81b1d44f09e65169d4622275a521c8ca1f2e765b318581d5c12b36aa72fe",
          "sha256:cb536efb43ff92f7d586d3be978b05d3ae9d1d892addf239605e77217648e6c0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.handshake_guest_never_materializes",
        "semanticClosureSha256": [
          "sha256:4c95982cfcdc3aec23c25135cfb78e31ae62334b18f916dbe81b3622c59b441b",
          "sha256:f35f29ac740be9ebf0ec44c3232826a6c97fe0dd5b2b914c78817656154b4b21"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.indeterminate_batch_is_current_not_terminal",
        "semanticClosureSha256": [
          "sha256:671a226d671b10765ce827eba3de65a8caf2399fc39b59673b35e811619448f7",
          "sha256:3a45b385fa77683c8fa3905a088f69cbad28e17f18f967a0957201577c95671e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.installation_registers_exact_derived_route",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.installed_route_is_initiator_with_event_dedupe",
        "semanticClosureSha256": [
          "sha256:2be6fb9ff07bf63849722e0b84fe9761b308972d2d287594b211da1b7a7f1239",
          "sha256:e7293ecca176bc8c84f6517830b7bff0c5fa4e80e4a7334f399f751b306e3637"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.interception_raises_direct_floor",
        "semanticClosureSha256": [
          "sha256:de0c4f07ed4e4555fc88dc42800c0ab3d48cae6157d7cccb558ac7e11c4ab5bb",
          "sha256:69183379fff0ecb0b4faa5bebcddcd8d61458c11146449622aebdbc854f94f78"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.interception_replay_deterministic",
        "semanticClosureSha256": [
          "sha256:8c910067fddf6f77f612bfa986fefcf60444a893dad9d12cc0c33c4e576d8ce2",
          "sha256:f2f401ebcdbf34ec5546b644fe32037f86151bc3253d3815261111bb4662af76"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.interceptor_order_total",
        "semanticClosureSha256": [
          "sha256:956a02cd1ab3d325ab093905a847528e223b7850234117b502ec21ad4a0ecca9",
          "sha256:278bd1360013aa4a428f4db3651a7f5a5c5057f1cea362fbcd373bc118b15804"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.invalid_arguments_invocation_rejected",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.invocationDigest_exact",
        "semanticClosureSha256": [
          "sha256:91b139c34dd85001b571515fbe272c63c081db6a5e787e5de112e150deef089f",
          "sha256:0c7bd5d93d1306e1892fad9f3a11d7071cdde1ce36bde12af477f62ad12c8353"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.invocation_emits_validated_operation_input",
        "semanticClosureSha256": [
          "sha256:7213bae959a7e10099dc297151f254e4788ce4db9bd63c63f0a5ee50a14c0854",
          "sha256:226060360df886521fdf267bbe67920810f726970229c60106cd68af7328cd64"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.isolate_capability_growth_is_host_pass",
        "semanticClosureSha256": [
          "sha256:b5c1008504289e9a2ac0b9c75f664620ddd127a71dcd1286fce8b3ec87294a24",
          "sha256:cbfd04b95e846171fd97de05dca4379e51acd97d93fd3815d246b05cf5ac5864"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.isolate_egress_matches_passed_destination",
        "semanticClosureSha256": [
          "sha256:b5c1008504289e9a2ac0b9c75f664620ddd127a71dcd1286fce8b3ec87294a24",
          "sha256:cbfd04b95e846171fd97de05dca4379e51acd97d93fd3815d246b05cf5ac5864"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.isolate_invoke_requires_passed_binding",
        "semanticClosureSha256": [
          "sha256:b5c1008504289e9a2ac0b9c75f664620ddd127a71dcd1286fce8b3ec87294a24",
          "sha256:cbfd04b95e846171fd97de05dca4379e51acd97d93fd3815d246b05cf5ac5864"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.item_claim_requires_reserved_obligation",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.item_obligation_uses_exact_audit",
        "semanticClosureSha256": [
          "sha256:8e7e5ea95af3068a1bef08f5a8c0d7e256988754ae9258ca2bf6cd0b41cc4b56",
          "sha256:a02e1fadaaf8dcb54593bf5e113555bd760c11b874727974d645bcb9f51b4dd5"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.lastRewrite_is_final",
        "semanticClosureSha256": [
          "sha256:a571a23cf5243c7dac004abf4a1396ffb857b226fbea754f8735670e8e12990c",
          "sha256:263e767fed82a4b2f8fdd9fbec07afa4acefe06b60aff27d27356b4d690e67f0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.leaseGateBool_eq_true_iff",
        "semanticClosureSha256": [
          "sha256:da0ed6b2ac05e76d0ac1e0a43f0c9ce3349d0be12c92b48df50778567265a2e6",
          "sha256:77dddcd211e97a50fb7c2b991c083016f2c4f1c178de5c7f519e6344b4ddcb67"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.leaseStepExec_complete",
        "semanticClosureSha256": [
          "sha256:ba2d31047be45bb54583831b972bd97c395c40fd7b9bbaa3e99e0c0fc3e80620",
          "sha256:afe310a8e9fac3b84d572a07462474783b82f0783fee8be3acd7ad992cd2176d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.leaseStepExec_sound",
        "semanticClosureSha256": [
          "sha256:ba2d31047be45bb54583831b972bd97c395c40fd7b9bbaa3e99e0c0fc3e80620",
          "sha256:afe310a8e9fac3b84d572a07462474783b82f0783fee8be3acd7ad992cd2176d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.lineage_ok_ancestor_covers",
        "semanticClosureSha256": [
          "sha256:ad9f52f8faae1004faa1284f4c3d68327676f80fe22ea902be023b0de642623b",
          "sha256:5e467cef146cf25ca88f40c38b426044ac1badfe205200936cb15217005ecf5b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.lineage_ok_ancestors_live",
        "semanticClosureSha256": [
          "sha256:24dde19414e3447d111db9599d610b5e171c18460f822fa26497ac388b6aa50e",
          "sha256:136e11dda291d286a1beb2c10312470b54664b35f77d617027c117e48964e389"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.local_cause_edge_is_typed",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.local_cause_same_actor_lower_sequence",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.malformed_first_attempt_cannot_continue",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.matches_deny_of_matches_request",
        "semanticClosureSha256": [
          "sha256:a066a75ebd24df376bd7b2afa3e4019a38c0504f4cc07b87ea538f8eccbd29a8",
          "sha256:edc83149feb7ad453b2f07a9fe2b89ea6bb84a2da262db2d0dfae824ca80f693"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.materialization_requires_verified_guest",
        "semanticClosureSha256": [
          "sha256:4c95982cfcdc3aec23c25135cfb78e31ae62334b18f916dbe81b3622c59b441b",
          "sha256:f35f29ac740be9ebf0ec44c3232826a6c97fe0dd5b2b914c78817656154b4b21"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.materialize_registers_exact_subscription",
        "semanticClosureSha256": [
          "sha256:0eb261f7c8ac6f505a909321ecb43b5ac6a423ac380c67711da789bb273b1abb",
          "sha256:4e53b7092bbc3914910d40ccc376a27b1f519e44826a30636e8653b212abc2f2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBlueprintId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionTemplateName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.materialize_step_preserves_installed_mapping",
        "semanticClosureSha256": [
          "sha256:0eb261f7c8ac6f505a909321ecb43b5ac6a423ac380c67711da789bb273b1abb",
          "sha256:4e53b7092bbc3914910d40ccc376a27b1f519e44826a30636e8653b212abc2f2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBlueprintId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionTemplateName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.mediated_nonattempt_preserves_attempts",
        "semanticClosureSha256": [
          "sha256:ffabbf20e1cb1d68c2b1275ed88b348657b91acaf434a0a0e28decf53d37dd28",
          "sha256:d516873b8f3349a308a40254bd83ba002bd9305df438c7577bc025e60192161c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.mediated_ready_reserves_exact_obligation",
        "semanticClosureSha256": [
          "sha256:2a82e70413a96e428d939b096a9cdf05f51293a0914ed902347aef2e959ef9b1",
          "sha256:260538e1f1bdb0aa9093ce3057aac4797638a5d8d74dd1f6aae937d6f141b359"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.mediated_ready_validates_exact_run_reservation",
        "semanticClosureSha256": [
          "sha256:ab908faf689b93f74f6db7ae5c62f358774833a3805e1b65ed9dfc7557f3a7cb",
          "sha256:d16e9366f57ca23f36c70cd4ab71d8fb2c8c63cedbe73bca4a0e0d024a82a865"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.mediated_rechecks_current_authority_path",
        "semanticClosureSha256": [
          "sha256:ab908faf689b93f74f6db7ae5c62f358774833a3805e1b65ed9dfc7557f3a7cb",
          "sha256:d16e9366f57ca23f36c70cd4ab71d8fb2c8c63cedbe73bca4a0e0d024a82a865"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.mediated_without_turn_has_exact_owner_audit",
        "semanticClosureSha256": [
          "sha256:ab908faf689b93f74f6db7ae5c62f358774833a3805e1b65ed9dfc7557f3a7cb",
          "sha256:d16e9366f57ca23f36c70cd4ab71d8fb2c8c63cedbe73bca4a0e0d024a82a865"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.mediated_without_turn_uses_owning_actor_path",
        "semanticClosureSha256": [
          "sha256:ab908faf689b93f74f6db7ae5c62f358774833a3805e1b65ed9dfc7557f3a7cb",
          "sha256:d16e9366f57ca23f36c70cd4ab71d8fb2c8c63cedbe73bca4a0e0d024a82a865"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.migrated_old_turn_cannot_terminalize",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.migration_rejects_existing_commit",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.migration_requires_fresh_commit_on_owned_branch",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.migration_requires_valid_target_pins",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.mismatched_custody_secret_resolution_rejected",
        "semanticClosureSha256": [
          "sha256:bd189ac669e86364c94d318117cfd9f7de2e151d406d379ffeb7462c16472065",
          "sha256:6ef225badd74de971ec5d155950aba796e9fd6c9f3d62bea8c34c9c788223cae"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.missing_content_resolution_rejected",
        "semanticClosureSha256": [
          "sha256:853f2715933abedf004a27e0db8b832aba47ab64526f182f2a445c8412cc2ccc",
          "sha256:7fefed63c4d6759f0f2e9b073463aa05008315ee0ccc1dae8e78adb0b8303377"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.missing_target_request_cannot_authenticate",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.mixed_terminal_batch_is_partial",
        "semanticClosureSha256": [
          "sha256:2aafcd104a70d8ae24af90fd6d612da91056017ee23baf474a413367163c66e5",
          "sha256:6c9a61df01d4087df8f7e827449f500025a7402309f3c54d4dde283627ff5401"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.non_contribute_step_needs_no_authority",
        "semanticClosureSha256": [
          "sha256:d00f35fc5b0d0b197dd676c0416f4f6b87d0c62dc775aeaae8db26f7ab347390",
          "sha256:aa07cb381efbc1ff2d6c10963c21d0089d8c7edf45fbb131ace57d348c9fa0d9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.nonderived_route_installation_rejected",
        "semanticClosureSha256": [
          "sha256:79a1b8a17b50aba838c88e808b3d27ef62b7e1dad91c7c46f34b93b50810782a",
          "sha256:6cca0264b76e2d5e7541950a8fb2ab8a74610ecb488d15ccc3eac598a250f241"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.nonroot_cannot_append_without_cause",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.nonvalidating_contribution_rejected",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.occupied_command_id_installation_rejected",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.occupied_slot_redeclaration_rejected",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.one_storage_serves_one_actor",
        "semanticClosureSha256": [
          "sha256:f510a3c842f43a0a237be01219f99b61e550374e82d3f453faf7a29f071a480e",
          "sha256:338f1f9fb219ed1d93cad9594f864b82a6390ad9d43b479078538ed37e128ce9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.open_session_pins_current_revision",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.ordered_schedule_unique",
        "semanticClosureSha256": [
          "sha256:560a3de3d64a215da9b0981b7f953f791f1ea8b8052503939c0ed715628c9ee1",
          "sha256:53a1f8e99c5f957c4a7d702aaa5898c0f8fbaad599204692c3094ec1dda72c06"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.owned_content_cannot_be_collected",
        "semanticClosureSha256": [
          "sha256:853f2715933abedf004a27e0db8b832aba47ab64526f182f2a445c8412cc2ccc",
          "sha256:7fefed63c4d6759f0f2e9b073463aa05008315ee0ccc1dae8e78adb0b8303377"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.path_index_defined_of_reaches",
        "semanticClosureSha256": [
          "sha256:f8d686d0217ff5badf4818d52e751b0e1dc0cf4dd3ce238ef73251ba6303f4b6",
          "sha256:a346e4ed1bbd19b37e1c2855443587434f425fcfe7316288c7c6cdef3475b690"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.path_index_le_iff_reaches",
        "semanticClosureSha256": [
          "sha256:f8d686d0217ff5badf4818d52e751b0e1dc0cf4dd3ce238ef73251ba6303f4b6",
          "sha256:a346e4ed1bbd19b37e1c2855443587434f425fcfe7316288c7c6cdef3475b690"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.permit_issue_requires_exact_authenticated_binding",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.plaintext_in_session_state_is_unreachable",
        "semanticClosureSha256": [
          "sha256:688d858296ac3cd59ffd72caea07638b05f03660e68601970223e6e1176968d9",
          "sha256:d7801681ae98429ba5cf172c26c9605ad2b363a693601a16bffbe8f51d8ec35e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.pre_receipt_id_cannot_be_reused_for_attempt",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.pre_restart_fence_never_readmitted",
        "semanticClosureSha256": [
          "sha256:f510a3c842f43a0a237be01219f99b61e550374e82d3f453faf7a29f071a480e",
          "sha256:338f1f9fb219ed1d93cad9594f864b82a6390ad9d43b479078538ed37e128ce9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.prepared_item_key_commits_complete_structure",
        "semanticClosureSha256": [
          "sha256:a8590f3806db6095d062416a05cf920a63ec8292d71dbcb6d6361c1bb61e3b8d",
          "sha256:22fb2124e81dc7f5ebf1ba447ccc56dd7ca4cd458947f103b726f1adcae247da"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.prepared_item_key_is_derived",
        "semanticClosureSha256": [
          "sha256:0cd5075d4ddd2db9be19c4d5394ecc10796a3f1d6f12744c5e3ad293d7a7113e",
          "sha256:bd78df66b51db7753e1f92320b45101832d8ed99a12866bea2c9730f8176ee8b"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.preview_ingress_is_exactly_the_exposed_port",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.preview_is_live_environment_session",
        "semanticClosureSha256": [
          "sha256:2342a631c36814609728a0c081c0a29f6ca31464659e5e04e0de2d5f4059e913",
          "sha256:8af584349da6a08cd149333c15f3213d5152c79e86921bf787697278743c24e0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlateDeploymentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePreviewId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePublicationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateVersionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.projection_uses_reservation_bridge_not_source_audit",
        "semanticClosureSha256": [
          "sha256:4398c4ace3c38998c61d72895026f30e0a23822d5eb87bbdc3542475c09315a6",
          "sha256:e756e6292baaa12056e96e12b1aadab551d382bec4b3e3c54da524400b4ce0ed"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.provider_contact_only_from_deploy",
        "semanticClosureSha256": [
          "sha256:2342a631c36814609728a0c081c0a29f6ca31464659e5e04e0de2d5f4059e913",
          "sha256:8af584349da6a08cd149333c15f3213d5152c79e86921bf787697278743c24e0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlateDeploymentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePreviewId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePublicationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateVersionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.proxy_send_writes_no_session_state",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.publication_is_immutable",
        "semanticClosureSha256": [
          "sha256:2342a631c36814609728a0c081c0a29f6ca31464659e5e04e0de2d5f4059e913",
          "sha256:8af584349da6a08cd149333c15f3213d5152c79e86921bf787697278743c24e0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlateDeploymentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePreviewId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePublicationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateVersionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.published_event_has_no_asserted_tier",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.quoted_prefix_free",
        "semanticClosureSha256": [
          "sha256:5100840bfec57c4a720c70901f05bf07edc25aac2a2c281f94469511d42559dc",
          "sha256:c1b73e2f385f986bcd86fd49aead1bff643fb0a30a5f1b34bd2028484a490630"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.reachable_attempts_have_exact_audits",
        "semanticClosureSha256": [
          "sha256:bc4ed9af94cde463d972a57013b134d64dae2c48d6437ab3af6a87ce9a51340e",
          "sha256:80f411fb5d788d1466366ca029ff61bb337658546d6a7237bd8fa3de873b3879"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_attempts_have_exact_issued_permits",
        "semanticClosureSha256": [
          "sha256:1000515ccfeaae075ba5b67bbd503ce73640499c5330ad6b5e71c761435e1c0c",
          "sha256:3f44af982e37c56e0f9a6819a167a8ed9e6dd4cb992219b2b9c99f1bf960c9a1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_attempts_have_guarded_admission",
        "semanticClosureSha256": [
          "sha256:e96c678666126c7e275940303ca3d1dbcae441bf4e6510144af70a576dbde6d2",
          "sha256:2ebe28cac1be25823cbe8ea12d3cfade250443741038610133587053581c02ac"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_authentication_uses_historically_issued_transport",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_carriers_ref_only",
        "semanticClosureSha256": [
          "sha256:d119dd615badb8af9cfa46971c5e13e8919f1338f0098cf2f4251e83d32f3936",
          "sha256:d2e6667ee90d4230b418b0039706a34ad28ea174b93a31bcd4e9f0d4253754f8"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_consumption_has_exact_historical_issuance",
        "semanticClosureSha256": [
          "sha256:bdc479e6c8dd52b3142046b65abafa4ce81ee7f16b56fb2f7cdaf231bbb7cc46",
          "sha256:c1cc44ffb1877e3af8ef4a0e53f92b4497bfccc6dadc561b99922d1d3b70ef0b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_consumption_retains_exact_target_request",
        "semanticClosureSha256": [
          "sha256:bdc479e6c8dd52b3142046b65abafa4ce81ee7f16b56fb2f7cdaf231bbb7cc46",
          "sha256:c1cc44ffb1877e3af8ef4a0e53f92b4497bfccc6dadc561b99922d1d3b70ef0b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_credential_isolation",
        "semanticClosureSha256": [
          "sha256:1ffcc098510cab97584883d248920500708efde7aba8e2e229d854dfac6efdf3",
          "sha256:56aa55895ccc1bb583c2b42bc345f9bc6e03a61157b16aecd71e5039d1e0f04c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_from_preserves_guarded_attempt_admissions",
        "semanticClosureSha256": [
          "sha256:f0688c248f13ce6231814ed4fcd5d31624f3cefa7061f245d49eef5731c40493",
          "sha256:e1b75d38c043d97fe4af1109bf9d036b3f0d7b2986646b3ae466005e3d4879eb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_isolate_actions_are_binding_backed",
        "semanticClosureSha256": [
          "sha256:1436ced946b6ddbcc12770c13303866df9d2ebe31ee398b55da78ed6d83ca664",
          "sha256:5f3fa9ca77ccde54585d841a64f8168744c391dc82f1fc2911edcbf8ae1ec7ac"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_issue_uses_exact_target_request",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_owned_implies_stored",
        "semanticClosureSha256": [
          "sha256:a9e0e916537b9c6ceeebd372c5ee409d2e36584a25f7da3945b4eeeeb9adfc33",
          "sha256:9fdd8e30ef2aa107e20e9b388932556a7e41f7d3a046a3106badb2ffabc6a692"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_permit_protocol_has_historical_issuance",
        "semanticClosureSha256": [
          "sha256:76b96c8ec36abb614f9bba716d26e6695e7793b31724ddf8cdb8e005b6ee990e",
          "sha256:48d0c2cfbb3bcb5140e587eb84ce160cea34dfdb4fbb0544bcd6865c1beefe26"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_receipt_ids_are_disjoint",
        "semanticClosureSha256": [
          "sha256:607f5939f613b302fad873aee867cd759a47a84a861597b11bd6972fe5f226df",
          "sha256:a58bf8d66d7372ce6182694e16342b1e2fcdab426aebb46b9610954820e41f18"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_recovery_is_bound",
        "semanticClosureSha256": [
          "sha256:3d0e84ac865b3e59068b21215fad83155b654d195c6e941fb8313758e8511fc0",
          "sha256:ceef4d4f2db65ed72152eb7c7429cb90fa219000c44eb46296cacd989fe830dd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_reservation_for_consistent",
        "semanticClosureSha256": [
          "sha256:6b8da6b92eb8fa152c5d7a9a15c479629d49634a0c252be9abdd3c12366f4268",
          "sha256:f76319ee89ea68acfb913f38402d9f852ffd51b339b1a3160e57d1ab6dc47a0b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_storage_never_faults_on_recovery_provenance",
        "semanticClosureSha256": [
          "sha256:0241952cff687f1c8b509e7dd5fb7fff9a36c4cbc7105095bddad78fef920274",
          "sha256:9b0835483113e344f69f9967c06388ff5100eeffadc17893ef6d0dc470f86e79"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reachable_transaction_anchored",
        "semanticClosureSha256": [
          "sha256:92bab32a4179665ea2fe452e688dfe84a47054faed48a5905ae997e63b4a3eda",
          "sha256:1c571e68ce33f8c6d20009587effd023317e52cf4f79bdb098cc29fe9f613e0d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reactivation_resolves_commit_unknown",
        "semanticClosureSha256": [
          "sha256:c225e731d4c8b25e34ed49c241e1e191eb5c5f79bffda150e86627dde2d75974",
          "sha256:c7df40c5961ee3c5f5f81aa0263555c5a7a174076ce42576696fa9716cbb2968"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reconcile_is_stored_identity",
        "semanticClosureSha256": [
          "sha256:0eb261f7c8ac6f505a909321ecb43b5ac6a423ac380c67711da789bb273b1abb",
          "sha256:4e53b7092bbc3914910d40ccc376a27b1f519e44826a30636e8653b212abc2f2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBlueprintId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionTemplateName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.recontribution_is_stored_identity",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.recorded_verdict_blocks_repeat_verdict_step",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.rematerialization_advances_epoch",
        "semanticClosureSha256": [
          "sha256:4c95982cfcdc3aec23c25135cfb78e31ae62334b18f916dbe81b3622c59b441b",
          "sha256:f35f29ac740be9ebf0ec44c3232826a6c97fe0dd5b2b914c78817656154b4b21"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.replay_deterministic",
        "semanticClosureSha256": [
          "sha256:eea3ae74155fe3dbe8cf8dfbce84af1b90670cf5ed6506476e45c556f959b285",
          "sha256:4bfbfb6e25482a22e594ee7aa1b79cf5c328a1addd0fbbe0fedeab127d5566cf"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.replay_item_reuses_persisted_transformations",
        "semanticClosureSha256": [
          "sha256:56a0dc641758937ce9c6c27f2bfddc18908bc5a990c400e0e4d502165e5a425b",
          "sha256:583863772df53235a5c19036ae5b5bc232050cd2ae49bce6c4601cc28fc2c4e3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.replay_matches_chain",
        "semanticClosureSha256": [
          "sha256:d27dc642209b8ba28111016a8a78e863b247b73ccd4c7d55d580c911934e176b",
          "sha256:f7cc4c6f223194c68b3c42e8100f7456a4f9cb8cb0b32fee868712dd99c03ae1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.replay_preserves_item_order_and_keys",
        "semanticClosureSha256": [
          "sha256:386d55b0124cbfbdfcbe5f57b962e02c8e391a49b1b1fb776b2918dd1708bc25",
          "sha256:23fbbe23dbcdeeb05abc2124299467cea781ce19f7483c22f77e12ad4c4472e5"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.replay_refuses_exactly_broken_chains",
        "semanticClosureSha256": [
          "sha256:d27dc642209b8ba28111016a8a78e863b247b73ccd4c7d55d580c911934e176b",
          "sha256:f7cc4c6f223194c68b3c42e8100f7456a4f9cb8cb0b32fee868712dd99c03ae1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.replay_revision",
        "semanticClosureSha256": [
          "sha256:eea3ae74155fe3dbe8cf8dfbce84af1b90670cf5ed6506476e45c556f959b285",
          "sha256:4bfbfb6e25482a22e594ee7aa1b79cf5c328a1addd0fbbe0fedeab127d5566cf"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.repoint_invalidates_prior_resolution",
        "semanticClosureSha256": [
          "sha256:b1627e867da1bd92259b09047f0dee1688cba407a2b5efb555184934faac6a52",
          "sha256:b8bae36cb9a658c20c6fdc60dbf22359593c598e89fd7c6f59b646f34c368351"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reserved_identity_cannot_recommit",
        "semanticClosureSha256": [
          "sha256:041606cbe659d5a33d6253c127a5ccc35a7980ae4a4f007f688362fc1de5c3d4",
          "sha256:69145bf3722be594c8e7d545ba5526dadf6478c6c912fdda5060f1b5ae3b40d6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reserved_obligation_is_in_registry",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reserved_obligation_yields_valid_reservation",
        "semanticClosureSha256": [
          "sha256:de36114cec17f9a547db11116682d8af59800dff530d9094f4ac53d2aa58e111",
          "sha256:afb9cead887b731b691fc0bfd43b2507325e787566cb29f5fa4ea86fbdebbc0f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reset_invalidates_volatile_authentication",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.reset_preserves_durable_permit_state",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.resolution_ignores_arrival_order",
        "semanticClosureSha256": [
          "sha256:abc027d0d29f454728e2a4f2acd2bf8accdd10db1e68541c76a80aac4adeaf53",
          "sha256:472dd6bee971a84e1698c542750ab4e31361221a8816d0435f79106d13446896"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.resolution_is_complete_and_declared_order",
        "semanticClosureSha256": [
          "sha256:b8402e3262d28b95b904bf423c8200318db86336d4d5ac19dece5feedfb339c2",
          "sha256:c3d47f05f31d4c628cffd1079e0556da6c52464dde7725f0a7c08c44f13b62ab"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.resolution_is_unique_declared_order",
        "semanticClosureSha256": [
          "sha256:abc027d0d29f454728e2a4f2acd2bf8accdd10db1e68541c76a80aac4adeaf53",
          "sha256:472dd6bee971a84e1698c542750ab4e31361221a8816d0435f79106d13446896"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.resolved_entry_is_stored_and_validates",
        "semanticClosureSha256": [
          "sha256:af45507c6b675b3b3dd7adecf8bbade70f7da4162455261470ac65956e002a3c",
          "sha256:d02b49fc1f6a367b653a51aa5aa87c574287cb172ca0da8e184ecc6066445458"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.restart_invalidates_volatile_authentication",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.resubmission_returns_recorded_reply",
        "semanticClosureSha256": [
          "sha256:041606cbe659d5a33d6253c127a5ccc35a7980ae4a4f007f688362fc1de5c3d4",
          "sha256:69145bf3722be594c8e7d545ba5526dadf6478c6c912fdda5060f1b5ae3b40d6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.retry_requires_prior_final_failure",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.retry_uses_exact_current_claim_and_advances_ordinal",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.revoked_exposure_admits_no_ingress",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.rewrite_precedes_every_gate",
        "semanticClosureSha256": [
          "sha256:956a02cd1ab3d325ab093905a847528e223b7850234117b502ec21ad4a0ecca9",
          "sha256:278bd1360013aa4a428f4db3651a7f5a5c5057f1cea362fbcd373bc118b15804"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.rollback_retargets_only_owned_successful_deployment",
        "semanticClosureSha256": [
          "sha256:2342a631c36814609728a0c081c0a29f6ca31464659e5e04e0de2d5f4059e913",
          "sha256:8af584349da6a08cd149333c15f3213d5152c79e86921bf787697278743c24e0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlateDeploymentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePreviewId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePublicationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateVersionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.rotation_does_not_retarget_open_sessions",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.routed_mediated_validates_projection_digest",
        "semanticClosureSha256": [
          "sha256:ab908faf689b93f74f6db7ae5c62f358774833a3805e1b65ed9dfc7557f3a7cb",
          "sha256:d16e9366f57ca23f36c70cd4ab71d8fb2c8c63cedbe73bca4a0e0d024a82a865"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.routed_reservation_binds_source_event_audit",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.run_attributes_last_rewriter",
        "semanticClosureSha256": [
          "sha256:dc6db5c25aabbb4fbcc22e3ecef4781f08de33e3925ba71f2031834501187d9e",
          "sha256:ff767e200b6b07f2289398864dcbe01e77d577e24a166a494de5859e1b1d221c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.run_records_transformation_chain",
        "semanticClosureSha256": [
          "sha256:f5b465a1491ab0669cf453b1aaaa6b59b307965a80243bfeaff7e1cd1a5d971c",
          "sha256:753c705b4c33cad962ec68636aa8af1d23755d37f6197081a45cdabd58e17f3b"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.run_replay_reproduces_result",
        "semanticClosureSha256": [
          "sha256:18c5c00e0ea2ecacb4eea99f983db8c77ddb8cc56ab482dfb996e25af7ba61cc",
          "sha256:d7fba8d0f5513c962093872701ed5b9aad26192f0f57e76574666856b0388d3c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.run_rewritten_value_names_last_rewriter",
        "semanticClosureSha256": [
          "sha256:dc6db5c25aabbb4fbcc22e3ecef4781f08de33e3925ba71f2031834501187d9e",
          "sha256:ff767e200b6b07f2289398864dcbe01e77d577e24a166a494de5859e1b1d221c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.run_start_reserves_exactly_declared_acceptance",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.run_trace_is_admitted",
        "semanticClosureSha256": [
          "sha256:ff5c4224f19471f0ee9ae7ae97b69939aa60b152a5e77489414d02e8fad4d03b",
          "sha256:e033ed24053f575d8666778a0b16322a1e79cef497fb3810c056f4080503e6b0"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.scope_key_injective",
        "semanticClosureSha256": [
          "sha256:a579dbbb51a8f3faeb281fc6467037ebd082b0f92a319853358c0a41005c0bc1",
          "sha256:82965df01bd766f1993c56acc3e0c61b60052a35efaf8dfc1d84b547c6037b3b"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.secret_resolution_requires_current_custody",
        "semanticClosureSha256": [
          "sha256:bd189ac669e86364c94d318117cfd9f7de2e151d406d379ffeb7462c16472065",
          "sha256:6ef225badd74de971ec5d155950aba796e9fd6c9f3d62bea8c34c9c788223cae"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.secret_resolution_requires_exact_tenant",
        "semanticClosureSha256": [
          "sha256:bd189ac669e86364c94d318117cfd9f7de2e151d406d379ffeb7462c16472065",
          "sha256:6ef225badd74de971ec5d155950aba796e9fd6c9f3d62bea8c34c9c788223cae"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.secret_step_preserves_carrier_ref_only",
        "semanticClosureSha256": [
          "sha256:150860b4c4f7707b928e6e30ce5e84025705c19d4111431dbd8d02e6bb75e95d",
          "sha256:87d221b97098bd328e5503966a831dba08032dcb95fd7832a5b48bcd040d624e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.secret_value_carrier_is_unreachable",
        "semanticClosureSha256": [
          "sha256:9abf81b1d44f09e65169d4622275a521c8ca1f2e765b318581d5c12b36aa72fe",
          "sha256:cb536efb43ff92f7d586d3be978b05d3ae9d1d892addf239605e77217648e6c0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.serving_past_commit_unknown_is_branch_dependent",
        "semanticClosureSha256": [
          "sha256:7b40892f0649022c9fa028c63560876f6306329b4fe65d30407ab88596ee6280",
          "sha256:c3e5a59f8b5cb21b6d5f3fe5800e6baf398e0595dd4f72b3082927cc74080651"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.session_egress_is_explicitly_bound",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.session_pin_is_immutable",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.session_use_is_turn_owned_and_live",
        "semanticClosureSha256": [
          "sha256:31e2bb656faa902a2db202a12af06aea11d5b6bcde40290b65760b917603dee5",
          "sha256:ca3edc267b193125acbfc7debb3966e2ef3af9bec0fddab55f699b1e062daa8c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.settled_has_coherent_snapshot_and_exact_obligations",
        "semanticClosureSha256": [
          "sha256:f256eb0378e88be856ad5531b309a5b2144ea81ea9059fad5e2699d5ce9e8168",
          "sha256:94f56a94568c1f807855fd539ecbdabb295b68bcb2df6a81ac7ddecfc456fa2d"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.settled_run_acceptance_holds_at_current_head",
        "semanticClosureSha256": [
          "sha256:10403c6df17569598e120e34829474102c3bb5110c0bd43f5c0d7d70265894c5",
          "sha256:fc8ca81564db3f87506e2dc950d524620c34cac4b88fa0b24bd0de3dd55fd48c"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.slot_reinstallation_is_stored_identity",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.slot_step_preserves_declarations",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.slot_step_preserves_entry_conformance",
        "semanticClosureSha256": [
          "sha256:ac1c7fb4b0c5246cb8d23d5c0960e471a74b6b39f93c62d5b99cee21f585502f",
          "sha256:319d2d95fea3f9c1949977b7612b79bf28f38017fc201fa978e8b07dd98d8b6a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.slot_step_preserves_origin_exclusivity",
        "semanticClosureSha256": [
          "sha256:17f7abebbc81d8d758fb523d5e1371e11e6dd90887233fad04ca33aac85ad40c",
          "sha256:2c24e625694b127a67025dbaf576c6386dd216ff98152363b236325f5abf85bf"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.spawn_child_rejects_existing_root",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.spawn_child_requires_fresh_branch_and_root",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.spawn_child_reserves_exactly_declared_acceptance",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.staged_writes_are_not_durable",
        "semanticClosureSha256": [
          "sha256:c225e731d4c8b25e34ed49c241e1e191eb5c5f79bffda150e86627dde2d75974",
          "sha256:c7df40c5961ee3c5f5f81aa0263555c5a7a174076ce42576696fa9716cbb2968"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.stale_denial_and_exact_audit_are_one_transition",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.stale_exposure_admits_no_ingress",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.stale_mediated_denial_matches_intent",
        "semanticClosureSha256": [
          "sha256:a1f4b76231b4e87efd314df531c078e57e0779ed515a4fe0d8d8085fcea984e1",
          "sha256:0e99e7d24602d0067adce30130e382908189a73f7f201cdf08a5683777088731"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.stale_session_admits_nothing",
        "semanticClosureSha256": [
          "sha256:31e2bb656faa902a2db202a12af06aea11d5b6bcde40290b65760b917603dee5",
          "sha256:ca3edc267b193125acbfc7debb3966e2ef3af9bec0fddab55f699b1e062daa8c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.subject_key_injective",
        "semanticClosureSha256": [
          "sha256:15f9d0f4c7a9e2ba8806ddf6ce1bce6396e2e9fb8be8a92482be236174f2f4e3",
          "sha256:f6683df2eb31462f7127b45ec29451e4c063e8e88734fe0d1c1eebdc9ac7a204"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.submission_step_preserves_reservation_consistency",
        "semanticClosureSha256": [
          "sha256:7a41396f0b02106d446cd9f59128acd486adbe8f88fa4a1cf96b423650b0d88e",
          "sha256:0a7f8ad586709a44853dcad23ab39daaf7130dcffebe5f5e09b1b5aaf2a18dfd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.superseding_final_receipt_clears_claim",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.supersession_at_most_once",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.supersession_is_same_attempt_once",
        "semanticClosureSha256": [
          "sha256:6e2c206e7f43f5e4b156c2a1e22a0becbe4348284d00365673548498fb636164",
          "sha256:c8969f22681e16dee4ca17543539ab58099ba9f7cacb15ff806e3ebda2e7b254"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.synthesis_is_system_controlled_exact_turn",
        "semanticClosureSha256": [
          "sha256:5efa4625ff5a4c0a0bdcf84cd6b1b66e76cbae6ef44d9da7b8d89c8d7fdc6580",
          "sha256:9f0d05691a14547a40ed98b715f95d4cc4b0c01f8a4ef13663e57107bd031aa7"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.system_control_writer_uses_exact_typed_audit",
        "semanticClosureSha256": [
          "sha256:5efa4625ff5a4c0a0bdcf84cd6b1b66e76cbae6ef44d9da7b8d89c8d7fdc6580",
          "sha256:9f0d05691a14547a40ed98b715f95d4cc4b0c01f8a4ef13663e57107bd031aa7"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.target_projection_is_exact_authenticated_reservation_projection",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.terminal_batch_is_derived_not_stored",
        "semanticClosureSha256": [
          "sha256:2aafcd104a70d8ae24af90fd6d612da91056017ee23baf474a413367163c66e5",
          "sha256:6c9a61df01d4087df8f7e827449f500025a7402309f3c54d4dde283627ff5401"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.terminal_snapshot_captures_complete_frontier",
        "semanticClosureSha256": [
          "sha256:05296aa8b44cf2da49312ee1a9c70d59d770e5c26ef1c2234e6ccf50b98983a4",
          "sha256:f28ea1ee01b23630f613e6283bd0d8b5fa8e15823d2866560d553581a0ca571e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.terminal_snapshot_has_no_omission_or_extra",
        "semanticClosureSha256": [
          "sha256:fe136ea7f5ae015ad0635029221714e3e0bd72287a156eeed801b287323eb0e1",
          "sha256:42fc3fb81ea25877249f8e213a54a10055050e78f81c2ea9b35c3fb110a0fdd6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.terminal_snapshot_is_coherent",
        "semanticClosureSha256": [
          "sha256:f3024bb6503179dfed25bcb09af1a01bcef1bb9ad66b7eaeb54f64f51ec90087",
          "sha256:dcccf8fdfd12fe3b131f74d32d969ab07c9ed9bd706f719bdadfad50959eb70e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.terminalization_closes_exact_registry",
        "semanticClosureSha256": [
          "sha256:36862199c5573fe4e96eddca38c1882a649533d4ddbf03df21d9bbc4b00cdb27",
          "sha256:b30be8888a7e0cca5858b9ea7cf5b17a5313281f4b2ad0f5d718c7056304d8bf"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.terminalization_requires_current_turn_pins",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.terminalization_requires_terminal_and_unheld_siblings",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.trace_epoch_never_decreases",
        "semanticClosureSha256": [
          "sha256:61999a83715571c811e6101cae1c708ee67b2edd439bf2fd8c8959971930664d",
          "sha256:bbba33800b94c6fce643223bb1bae21a6f4052a3a7283dc1d980d8640a8f9cfb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.unary_commit_inherits_pins",
        "semanticClosureSha256": [
          "sha256:5efa4625ff5a4c0a0bdcf84cd6b1b66e76cbae6ef44d9da7b8d89c8d7fdc6580",
          "sha256:9f0d05691a14547a40ed98b715f95d4cc4b0c01f8a4ef13663e57107bd031aa7"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.unauthorized_contributor_never_lands",
        "semanticClosureSha256": [
          "sha256:d00f35fc5b0d0b197dd676c0416f4f6b87d0c62dc775aeaae8db26f7ab347390",
          "sha256:aa07cb381efbc1ff2d6c10963c21d0089d8c7edf45fbb131ace57d348c9fa0d9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.unauthorized_interceptor_never_attributed",
        "semanticClosureSha256": [
          "sha256:ff5c4224f19471f0ee9ae7ae97b69939aa60b152a5e77489414d02e8fad4d03b",
          "sha256:e033ed24053f575d8666778a0b16322a1e79cef497fb3810c056f4080503e6b0"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.unbound_send_is_refused",
        "semanticClosureSha256": [
          "sha256:494af79b79d9f33216257f289ef0c3bf620a9858e3acc0080335a8105ab4c3ac",
          "sha256:c891ee609fa255238d1f097f6f3fa7ee2d635076ac5340ca5897604ee00ca7ca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.undo_fences_held_turn",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.undo_keeps_prior_head_reachable",
        "semanticClosureSha256": [
          "sha256:bcac8beba6cb20886822e9a8dab0bfc6b9d03241467fe96c1c4b793f15f170dc",
          "sha256:a78bb2fcc0eff4d29968b9aff3fe879b7151582c3340c289560a389947c5f6e2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.undo_requires_unheld_branch_and_ancestor_selection",
        "semanticClosureSha256": [
          "sha256:5efa4625ff5a4c0a0bdcf84cd6b1b66e76cbae6ef44d9da7b8d89c8d7fdc6580",
          "sha256:9f0d05691a14547a40ed98b715f95d4cc4b0c01f8a4ef13663e57107bd031aa7"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.undo_selects_effective_state",
        "semanticClosureSha256": [
          "sha256:320077229f7b5bb23eb00020632cc92640124b2db43112409e245cde8d088190",
          "sha256:8e283694db2f25bba5f0c3113d7b5ae87a9446fdfd26d74e4edfb0dd966791ef"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.undo_then_redo_restores_effective_state",
        "semanticClosureSha256": [
          "sha256:320077229f7b5bb23eb00020632cc92640124b2db43112409e245cde8d088190",
          "sha256:8e283694db2f25bba5f0c3113d7b5ae87a9446fdfd26d74e4edfb0dd966791ef"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.unescapeOne_escapeChar",
        "semanticClosureSha256": [
          "sha256:8bfe01b2cb2b244b198f370f5e140d697886c7489e850f28418bccab1061724c",
          "sha256:ec60e6a2f64539d3485f1301554a5c1c35ac2a1ef587d15ebdfd0f651d07c242"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "claim:AgentCore.uninstalled_command_invocation_rejected",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.uninstalled_slot_contribution_rejected",
        "semanticClosureSha256": [
          "sha256:474939b743016b7480063f15ac9247ac43bca95872913b30af8a3c42b4f17c4e",
          "sha256:ae140b82ee19719de77f28b04bb06ebdd2baef1845f7ba8c86ea1a7115576ba0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.unprojected_reservation_cannot_deliver",
        "semanticClosureSha256": [
          "sha256:b9c958fe9a468b9191d3ce85e57da7d264416941abc767d4cc021adb40ce0099",
          "sha256:4eb18c7506682f32de9c7d9104dbf1d9c325856dbe88b5576e1083d076e79262"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "claim:AgentCore.unsafe_mapping_installation_rejected",
        "semanticClosureSha256": [
          "sha256:9d1f6064cb228638c9d828c277ffea59d4a5e957f3efe956eb9714390d0ddc46",
          "sha256:c9409836818ec0ae028ece6037ccab18219625480a89dd3f41b81c53e38ec349"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_abandoned_claim_same_ordinal_recovery",
        "semanticClosureSha256": [
          "sha256:55eff6cc1dddc4e985df342e81276959a8beaffc32e57b3b054bae106ca7ecc4",
          "sha256:d85aac0bf1542b342f53fa3cd3ed9bfabcfd417f041d55914c1c5c4a952ee99e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_completion_step_rejected",
        "semanticClosureSha256": [
          "sha256:68bf7e0aa2ecf647b864ec214f2ec31c2c6d9ae38dea77eccec9bb870fef5be4",
          "sha256:c0fc115bcd22157e3d41947d5a482ad62cc1b26a160137ba9e74e547e6757ca0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_criteria_reserved_at_open",
        "semanticClosureSha256": [
          "sha256:dc6ac7e696984b23b0ea5c8c1976d0d4e58952e13efe01338ed552dbd19973e2",
          "sha256:9a1cad564c0a49537541eea02daae00cd85885b0dfd7fb4c30b2a1bb673aa5ea"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_invariants_along_trace",
        "semanticClosureSha256": [
          "sha256:bb811b37eb2649e58459fdec19e6bd2f82cbc2e7538fb24b637a294fb5c58c87",
          "sha256:7c09531cd82898bdb710819e6f0cfa23e175ccfd5dfb75bf6b5f09e15ba8efc0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_obligation_stays_outstanding",
        "semanticClosureSha256": [
          "sha256:0a180aa0d55a873e30ae623221bc8bfe29908e48028d47b52400597091458f66",
          "sha256:0ec8d5399e5fd762ccc8bb795277a8d1fb993006e4cbf37de6757e5e25b60f9d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_open_verdict_trace",
        "semanticClosureSha256": [
          "sha256:2b31213f3bf054bef1e43c296ffbce35fd88d17ac18cdd979b466e3e33373fc8",
          "sha256:59d93bb1d0357a3ee6c480be29874863fe8915dde5fc3cc47edc0f69d3d56547"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_repeat_verdict_step_rejected",
        "semanticClosureSha256": [
          "sha256:68bf7e0aa2ecf647b864ec214f2ec31c2c6d9ae38dea77eccec9bb870fef5be4",
          "sha256:c0fc115bcd22157e3d41947d5a482ad62cc1b26a160137ba9e74e547e6757ca0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_satisfied_at_head",
        "semanticClosureSha256": [
          "sha256:57564d72af644b8837bf163647b8eba262d455079cc4289727873a1f6c081dc7",
          "sha256:b4067c6dadcfc0da4b1f1d3648f080aced7375d24379969a1c1e9cf36ccee545"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_settlement_invariants",
        "semanticClosureSha256": [
          "sha256:f0a3b569df4e2753fe0efa9d4f3a39502c07f8303a434a8547a8bbff2240a44f",
          "sha256:6f493c98e0b6b18b5eece6c5fc9eeecbd52e6aa8a8add0720ca85be076bf3545"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_verdict_blocks_retry",
        "semanticClosureSha256": [
          "sha256:725eafa4da699c07fb27d6f0d7edb19e1d3f373530195f13bf25d934e3d9d722",
          "sha256:45950d2d0e194ab74fabeb5e023fb7d17b5a18f20f270bef07a9f6951fa33c03"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_verdict_recorded",
        "semanticClosureSha256": [
          "sha256:eda1e66d08f1053403afd69cb9b6c1e1efe7003f962463259df495c6d6aab52f",
          "sha256:3d03108ed25b34cf3230ad55cd83cd7f11f20b44581218996fd4cb192172b57e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_verdict_settles_run",
        "semanticClosureSha256": [
          "sha256:5ea0897a7eeb25cafc83ded706ddcd3d375b78e508ee69fea32c1269953fc027",
          "sha256:eb42094fc87aab2cd4c8499e0f7ff1571417757d7816f49b8aad190a1277ae78"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_verdict_step_advances_registries",
        "semanticClosureSha256": [
          "sha256:3e81f5d893eb0bffa61980d7bcba97adf505ff888841cffa424cf94dc7b38578",
          "sha256:18ed5d3fb457281eeaa19d68be6ce189940b435b45f0dc55f09fc09d91fa0832"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_acceptance_verdict_wrong_subject",
        "semanticClosureSha256": [
          "sha256:0d982482ef5f8716adb54fcd1a6f9a06193f9e1cdad957fb6f52973cc043273e",
          "sha256:e6cb79fee38a88cbe4d59dc96db271585b01cdf6a5799fa4be1040e4b05ce15b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_activation_discriminates",
        "semanticClosureSha256": [
          "sha256:cd8b4905a1933550c79e41a3d832f2fc6418772bfe50c38530a4a91648ad69ea",
          "sha256:0ed13d852dde45875a1d1ad5b730f2f38932361724dfda9d21189ac983381ba6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_command_gate_discriminates",
        "semanticClosureSha256": [
          "sha256:3c0f360f3a716d439ae2bda894d4e259ced3d8324df1549dbe40ceb169192a11",
          "sha256:cc1b634e3a255f5522193f90ba4786ec19fd10a630f13557de7ff5f3e97ecdc1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_commit_applies_every_write",
        "semanticClosureSha256": [
          "sha256:e5ffb328dd4fce07ab120ac473c024ce8c272bdf7c8886a5f0123f669593da47",
          "sha256:3e173938e448f2366229c77d25ec56bbf87645b5740531697359dc6ab56c8754"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_commit_unknown_branches_differ",
        "semanticClosureSha256": [
          "sha256:d33ac631b67178671f3439f82f1615e923e233a79d6e39e04b9d8a291b8423d6",
          "sha256:0f8003e1b6506f74212abf776820d8a8abb067788afc6dda2d9896067203af37"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_local_typed_audit",
        "semanticClosureSha256": [
          "sha256:32e5670cd65b64e0b69c616e72bf1733faf296658cca4a930999712234d12fe4",
          "sha256:d4e994f67bbeb95282bb56910564b7232ecc80877f0326887d5b448d649c9116"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_nested_commit_loses_a_write",
        "semanticClosureSha256": [
          "sha256:652b83fe09ac5915aae07eff0ba7b43b5e6e187ff863a5f9dd01eeaf46ca9d39",
          "sha256:102145ce645304d04d80a304a7a1899841d1fb2069e6b6a0e6b2a1ea7f627fdf"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_persistence_trace",
        "semanticClosureSha256": [
          "sha256:e384be3f4032c16ecaf6c5e87597c35b8ad9d8990d2523bcb9d9b574c1b6950c",
          "sha256:addaccc56cb95a041284f7f83b64a6bc6f2d190a149ae4827d2410e4ca20cb4e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_reactivation_retires_both_branches",
        "semanticClosureSha256": [
          "sha256:1e1c6e5e7313b47fc23bf5b1020d90f26d5eda9d9569f9007d7fbffa8167c82d",
          "sha256:64b5385d49e2d85ad5941843de6368b58f105f1cd125e10cfeef4c4d6805b715"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_actor_rotation_is_not_a_restart",
        "semanticClosureSha256": [
          "sha256:f90c736bb5242b404c2a6851af01008cb1c1b1fd1335a73644a8b13c8cb03b5a",
          "sha256:6052fed1b5d210d64b9069948c02063b26b07de686692843b4cbea693b978c69"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_aggregation_chain",
        "semanticClosureSha256": [
          "sha256:054c4bfc4d14ab742561f3d8bb30ac4f52dbd8a4653d7f1c371f805501ccde14",
          "sha256:557059724e5c09c2229dc2fbe47496669c0fce8f3eed93e00708c41672ed038c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_approval_start_then_continue",
        "semanticClosureSha256": [
          "sha256:c9c01f68553ab30f2521a62ef15c0aec70b74320097acdba0318dc7135201fcd",
          "sha256:cadbf65cdf9dedefada3670e74f179846c4516b9d81b58181299a6a088915b11"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_approved_attempt_audit_atomic",
        "semanticClosureSha256": [
          "sha256:ab0c7ec78946621deddbaaba940fff5aae9d0e706f5a63b590cfb2c4a35e7329",
          "sha256:cb021a1501bd2575ef9bfad87d169c7ad1a707e8c2af31e3b9d6eee66225e68a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_arrival_free_resolution",
        "semanticClosureSha256": [
          "sha256:e71d8faa6719069f41f70a63dcd04a4b03c1f15e69295bb4358e7a2256f1f997",
          "sha256:cfabb55b7f35ca489e55ff1a3433fc201c78bbce0b619c148b7ae5acbeee3dbe"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_attempt_permit_evidence",
        "semanticClosureSha256": [
          "sha256:1000515ccfeaae075ba5b67bbd503ce73640499c5330ad6b5e71c761435e1c0c",
          "sha256:3f44af982e37c56e0f9a6819a167a8ed9e6dd4cb992219b2b9c99f1bf960c9a1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_attempt_receipt_audit_atomic",
        "semanticClosureSha256": [
          "sha256:dfc8efef824d6437a86e269d97191499d3a7c7d6045d42b40f16e2f72bff71dc",
          "sha256:d199cffa3d5f769d59200ffc91600a851664c114124ca8309fbc91f313691af8"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_audit_complete_derived_settled",
        "semanticClosureSha256": [
          "sha256:ae6a917dbf3f3380dff2b7f3542a37fde9f897b26d13562477fa619173b1160e",
          "sha256:ec16cbbf252ba8b25a7b7ad1a185576ec1d22373ef8e3f143dbf742687ee6634"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_allows_without_matching_deny",
        "semanticClosureSha256": [
          "sha256:07d75d084a246f167ecd57c3ae41fd41a1df36318207fbdfcc356fad38775f9e",
          "sha256:c0ad75e97e2b51152c1acc5a84a61240378fdf86a7cd319d5f3e21257f942622"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_ancestor_deny_overrides",
        "semanticClosureSha256": [
          "sha256:bbe892537c420c28e53857398894acb2c3dbe36a7e44b0070bd5f8aff2689fb7",
          "sha256:17c1e307fcbfad886dd7b9d94e3fbdfd42e7e0d4b44dfdb7454cc5f1de87bca0"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_grant_matches_discriminates",
        "semanticClosureSha256": [
          "sha256:1c9887f89296c333fb5d888c5a9e254f6a10bb167b4746bf09401c7f49f6c784",
          "sha256:f3f3fde50d1db6295ca9f4194a0bd3157dfe77d87be45cff9dbfa0468080f42e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_guest_deny_crosses_schemes",
        "semanticClosureSha256": [
          "sha256:1bd8e4a6d267568db15abf02d5b077449a7cc7008b6c1254365614e906bf0e06",
          "sha256:6babbc9bdee4f58fd5eb0beb93b703265e9412f694be8fc377eaae3aec4e306b"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_guest_elevation_refused",
        "semanticClosureSha256": [
          "sha256:dd1464637030adc66675fd4cfb3dd2ab120336c6a9de3c8ba73507e279126864",
          "sha256:9598def058ca55efb3007897c5be58241bcfed561c99ae3d21b42406e6bbc207"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_lineage_walks_and_refuses",
        "semanticClosureSha256": [
          "sha256:cf7da6652123dda4dac7fd71b5453c13ca834c950babab4972bba9b2a21de868",
          "sha256:97e547155d8458dead5f42af31bcba2844f6f8956b74e2c47258c170e474a3f3"
        ],
        "lost": [
          {
            "name": "AgentCore.instDecidableEqAuthorityGrant",
            "class": "toolchain-shape non-materialization"
          },
          {
            "name": "AgentCore.instDecidableEqCapability",
            "class": "toolchain-shape non-materialization"
          }
        ],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubject.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubjectIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTeamId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authority_path_index_orders_chain",
        "semanticClosureSha256": [
          "sha256:331f098d43be60b8210a1b8bc4d9b7af571b53d715df3e66d7089a96627cf9b4",
          "sha256:64808e68c324d3805e8b05dca6927a55144488205a513e0146291be99621d53e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_authorized_resolution_issue",
        "semanticClosureSha256": [
          "sha256:770fe1eb8bfadbb05bf947e635dcbe492742f2930fbe509c29979145e2efa2e8",
          "sha256:30365b7be8800c6b0c9ba16f42e9d8a755c950c56476210958fe65fc16d1c93d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_batch_replay_item_association",
        "semanticClosureSha256": [
          "sha256:f328b98f2f84a3640fad36ef7b8b55d9329f009051f68ec730c22ff8704299be",
          "sha256:60e4748ec0f9b5f44d747f71533b1d443b6837bacd428841dc4a73200583c78f"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_broker_apply_action",
        "semanticClosureSha256": [
          "sha256:8b97ac87c34c179dd4a1e645a9d39313b9f7fcea9a8a6ad72278d9dd823c2318",
          "sha256:060efe8689bf53dad2628c6192e89bd135fa5d2300dcfe02c18687779046e580"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_broker_available",
        "semanticClosureSha256": [
          "sha256:f7b5dd17bea0b9c250e96cea8b729ab8b862e959080b84af8e372028471f9d28",
          "sha256:573abbadcaf0b6a1dbbad627abf714ce3e31c49e2282c034ae6947a4bc8a38c8"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_broker_rejection_cutoffs",
        "semanticClosureSha256": [
          "sha256:3839d7b5e43f8c30eec8e78460c2b9c5ac46ac4e4183f048c265de0879405425",
          "sha256:c2da9657d8f646d2f221c43fd2f5fb571bd4e0c121721c5a095fd31cbe9a2eb3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_encoding_discriminates",
        "semanticClosureSha256": [
          "sha256:9940bdd71afbb713709abb2877a1259db72426de48bfdbc8ccebedd9d7409cdb",
          "sha256:8aa59fe24b8ef3e3b6db9a61bb023165fef74d481363a8eaf0f0372eac9f24ac"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_key_separates_delimiter_collision",
        "semanticClosureSha256": [
          "sha256:aa83224a34f6c2755a69eef4a5797598714274836d0ada34fac0d6a3141f5ca2",
          "sha256:88e385bbd9e2ee413d47ccfbacf667a7ee56ea1406978285ad9fd68541821154"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_mediated_attempt",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_mediated_attempt_audit_atomic",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_quoting_separates",
        "semanticClosureSha256": [
          "sha256:b6ee10613a6abe77b3078980948dbc701023e56d38783a0e5d7dd0df1bc11ef1",
          "sha256:f0da4d0c055c355091c612dd5aa59f8548820546cedca00ab16a92fae516e04b"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_scope_key_discriminates",
        "semanticClosureSha256": [
          "sha256:ffb74e38a775f0a553a5e2117da33d8cb7ad35d9e6ea0a96d3b6cf53103f757f",
          "sha256:10cc86d6efbc011651af637c5b02890f03a48def56d10d447bc4c98a6353b81c"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_canonical_subject_key_separates_schemes",
        "semanticClosureSha256": [
          "sha256:c6b59b54d222b57a6b6da9a8c484dcef58a0ed286e379afd4c24fcee2c107aa4",
          "sha256:86c4f48f980c1db70e614e1fe9dbb28e740a1ccdbdbb35da6ee64d881aca09ec"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_admits_narrowing",
        "semanticClosureSha256": [
          "sha256:a6ace6b6d09921704a367c9ea76cbfbb7b8bf55ad605b1c6395ab512f563fff8",
          "sha256:814f3600a4e7540fccf2af12130f8169363beff35b6cae02fe8c42ab6c8e68e0"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_matches_discriminates",
        "semanticClosureSha256": [
          "sha256:2371f9717717d5447282151872b1898b74ab225f097e358ca983ce4c479035e4",
          "sha256:437c8b8b001c1c1b9d3cf8c2aa095664bbec1542f1b404a7c0e65093ac54aea4"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_refuses_impact_widening",
        "semanticClosureSha256": [
          "sha256:663636420a0fa7614886a61bbb5f89c7bfa0fb039cf442c9d2658bdc1f59064f",
          "sha256:8365aef55d3fab4112cd5987d21a1e4b5bfacf2bf70dee0cb2ce499d1db15c7b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_refuses_pattern_escalation",
        "semanticClosureSha256": [
          "sha256:ff9276e672dc7315d8dc4f416e0c0a726f7531176c519cfdcac5839a60a28be7",
          "sha256:c98afcb6449bd648ebe65810a2815faa036449ca381148aba07d1c781d745a5c"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_capability_validity_holds",
        "semanticClosureSha256": [
          "sha256:59ebfbbca7295f210a4b1d617088c9be738dfbb4f153e663d8ad6dbb59d0c366",
          "sha256:29116e30fb8bbd1a96d465c1d8838630c154aace3eec1253885df8de91a36d90"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_causal_chain_preserved",
        "semanticClosureSha256": [
          "sha256:bee995dec86ab2750dc6e66b4b7848209ce2b9345021a54cb39d33065f2717b6",
          "sha256:ddce79517b447ee34f4c58dcb78743ee8f5b4112c0f8d4164df72da926e57679"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_changed_fence",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_changed_run_registry_epoch_rejected",
        "semanticClosureSha256": [
          "sha256:e3652c175eb91eefbd325d3593b2c9591d227f17b5d935e8667b3a7fe1fa31ef",
          "sha256:62e819668bc6e189dc57ec0572ef4c33e3348efe1d72be235306c1b19be9b7ab"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_child_acceptance_criteria_reserved_at_spawn",
        "semanticClosureSha256": [
          "sha256:1e0c1c881f15ba9a8c2b4a1a7ef0b4dd554c3bdda8de5e430b2fc96c4d6d0ed3",
          "sha256:9f61f43b687b2ee36854f9b503219fdd73e3f04350ae916af02cf114fa1d9cbb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_claim_records_future_expiry",
        "semanticClosureSha256": [
          "sha256:390f63101c26a16d8d22cb1f6b153ae07ec450c94cf977ee8743981bdb635385",
          "sha256:8877429c47327f1258c8072f5d9222ba3a5e5d8e891061a15a4a93ba92129705"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_collected_owned_content_is_unreachable",
        "semanticClosureSha256": [
          "sha256:cb00ecf03d2bc35c1da48fdc75a1d1b3db1757f4a1a6f993f98849f9d2926b8c",
          "sha256:6f9a95c8fdfc7306a1936a6c410a14ec354b7a04ea70872dcc865a5663ca0e64"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_command_installation_and_validated_invocation",
        "semanticClosureSha256": [
          "sha256:999894c56b66ce6a59ff36e8352c10a98e37b7c60edef131b1f47ee11b5aa442",
          "sha256:756ecbc9d9944843d90362b03430f528a18f4b4dd31e86f1a8d6ac08650129cd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_command_reinstallation_identity",
        "semanticClosureSha256": [
          "sha256:755d0e39987b615795388e0037aac85705b2201a153c6eb72329e6a4a714510d",
          "sha256:dbcddcdfd31d4d7f586055734b8a99d891aff810a9b13da9d02548d99530af3b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_command_surface_collision_rejected",
        "semanticClosureSha256": [
          "sha256:2db6524fbc2a976db08893406da68b4fdaf3cac3ea716ee500814c530bdd34d3",
          "sha256:5f2c82815fc12e47877181b35ab95676d8a2bd11cbcc9f9297c21db18eb32481"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_commit_unknown_before_after_consume",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_commit_unknown_before_after_issue",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_complete_identity_and_keys",
        "semanticClosureSha256": [
          "sha256:35233d95c234c95a5eca807e704ac23cc387e448134f8559d17d1927c6eed820",
          "sha256:55e1a3c4901545f8f07b67e48c299287eba4b53d61adf840870edfb5bb64ac6e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_conflicting_origin_rejected",
        "semanticClosureSha256": [
          "sha256:4dd680946f7b29c1568fc42c62a0e2e246979269ad69cd094994485ac57c264b",
          "sha256:137c3a45702677604debcbb48fec6dca408ac74453914d014d5274db73649e4f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_consent_revocation_blocks",
        "semanticClosureSha256": [
          "sha256:11d3abdc20242c405d3cc12c26e27dee93fb4f373f9ce241239e98ee6274589f",
          "sha256:f3e1b237cb11d231c5485cb30bff579d24be299f16b0726b7bc9756e2699b8c1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.Representation.Consent.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.Representation.Consent.instDecidableEqDeviceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.Representation.Consent.instDecidableEqPair.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_content_cross_tenant_grant_admits_resolution",
        "semanticClosureSha256": [
          "sha256:ae5d721e24111b9069c7678af7da106094563a3daef20b452c382fa2c0af7787",
          "sha256:2542a10f27667b08ccc29becaa97ac383dd211ff8d67173b34fcfbd12dc4743a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_content_custody_lifecycle",
        "semanticClosureSha256": [
          "sha256:c76d333e1b2fe3b8a2f643f73a8ca35670c895f9c9fab3ae2a7ade7636804dff",
          "sha256:976b581ce01860e87291f6a5f52c0b75c8ae21026cbbd10b89fe1777e04621a9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_continued_attempt_audit_atomic",
        "semanticClosureSha256": [
          "sha256:ae0eacbd34ab2516ae823e851b458375d3ca4fc9fb6387dcd9725c8ff8084983",
          "sha256:607a99f0f1cf1f52ba2c32b5a4c46004c29a061c69f3b0820722b4cfa0e20f54"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_covering_chain_reaches_leaf",
        "semanticClosureSha256": [
          "sha256:567d1d8ac641dcc08f55e2b77cfbd7057ed07b15a6d378a2620d5688308aa3c9",
          "sha256:fab9a09ca0727e5055013e5d7d54c1feed4305fd49549362cbd465a0de6057f4"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqArgumentPath.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCanonicalValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_credential_isolated_session_trace",
        "semanticClosureSha256": [
          "sha256:f69a906591e76f5b2e804c63e80221bbb4cd47c020f9d72bd4ebeecd2510076a",
          "sha256:c1b036cdc7592f99e57ab27d4e5bb6d261e9cdd9b57fa4b949318158c0958665"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_delegation_containment",
        "semanticClosureSha256": [
          "sha256:2af1328d3561ae0219e87b3a3b67ebdd387eac16f4a830debe40c61642b3174a",
          "sha256:62d09a54ef64dca2677d06a038fdda0b6093a73e8ac2d1141daf05daccc04464"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_delivery_local_audit",
        "semanticClosureSha256": [
          "sha256:82cb0616e6f8d58106d310ef691ba3d9e001090b39d97137e88ddeb1f2abc1cb",
          "sha256:894279923530447f99ee644b8256eb2147fc3488e8c6c494e96b8fb324bc3088"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_delivery_planes_agree",
        "semanticClosureSha256": [
          "sha256:b667c67d63c073f015dba834dad6a7bcf17951463ed589bd1ae8f30a221bb762",
          "sha256:27665a9e9d8599be157a8206193b62fa1945dcb6051c8e88b72b4a616b67e25b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_delivery_writer",
        "semanticClosureSha256": [
          "sha256:d164eafe4e2abd724785d45d62613e41ad769ecdfc113a492e2608c0cd37ef48",
          "sha256:aa0321c58ddf320a8c2c7125573401b3a29f671eac63a932e0ce7e094da4b176"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_derived_subscription_exactness",
        "semanticClosureSha256": [
          "sha256:4bbc16d8b09f6e5dbf38136d09ae764d0c29cfffec36b98bab4b5ddd73ee116a",
          "sha256:68aca633be526bbf26b62cd836ed001d390df635a160b49699758882c803eb30"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_direct_nondurable",
        "semanticClosureSha256": [
          "sha256:9c36e24e6c80b1091e220353c4b6e5faa36f6896d8dc1152dcb3eeae8d21ca5f",
          "sha256:1682693448aedafc5900d891060923234f7d5386a24c7e625b28cd8987794644"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_disabled_subscription_rejected",
        "semanticClosureSha256": [
          "sha256:134346573114a655bf982473300344715fd2fcb14fdc08295a77366c40e48e3c",
          "sha256:802c077ac33779e44b517c21f1fdc670e2936bf3a5f0e96ebfa34c8984e616d1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_dispatchExec_matches_commit_then_duplicate",
        "semanticClosureSha256": [
          "sha256:1a31f4e718ef814b93d7bca190350dea2c7d2cb174a21e0587bf07bc21d93442",
          "sha256:1ce44b14ef378c1c58d224293e3dfce37ad5415f4ef438e9b6709f7474612c81"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRawEnvelope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_dispatch_commit_then_duplicate_never_mutates",
        "semanticClosureSha256": [
          "sha256:beb3aa2dc214e09b812c85e359655fb40cc0c6357d8aea2cf3f11bbc3fe8a4ed",
          "sha256:30cdbd38cb19a79f0c8250653c6f702c62c3dfc2269782e566208481ce87c9ad"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRawEnvelope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWriteRecordId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_distributed_permit_issue_consume",
        "semanticClosureSha256": [
          "sha256:bdc479e6c8dd52b3142046b65abafa4ce81ee7f16b56fb2f7cdaf231bbb7cc46",
          "sha256:c1cc44ffb1877e3af8ef4a0e53f92b4497bfccc6dadc561b99922d1d3b70ef0b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_distributed_permit_replay_after_restart",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_double_reservation_is_inconsistent",
        "semanticClosureSha256": [
          "sha256:f329e3ae9d109071991a7e5f22c62108c6a7362db6fc9dc909c00bcdde43d67f",
          "sha256:def078e5d377b4424722e32f8300d270fc0e1dab3414d400459ee2227e10fca3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_double_route_reservation_is_inconsistent",
        "semanticClosureSha256": [
          "sha256:b34ded5a7f0a823e151ce0327903b0c2831c020605eab2ab10dbabbc1a75879d",
          "sha256:4957295428fbf1142dad678884db4d58169e744ae9b75952d477dbadde70c3d3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_duplicate_submission_is_recorded_evidence",
        "semanticClosureSha256": [
          "sha256:643a7f7827303c96c57c44cc3638bf59b470c8d492a3bbbc8a0501e9cf211808",
          "sha256:be825cc65b2eae17795184576258db635f6176782a85e4057ccf74095e092637"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_dynamic_isolate_provenance",
        "semanticClosureSha256": [
          "sha256:1abfb5778c33539faa41fd82bff7b8786d8a8d56164c20a197d7884c9bd1a962",
          "sha256:2e11153cd62b9ab7e8e5b01858e353da56c77a52087f6f939a601711589dccf7"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_empty_coherent_terminalization",
        "semanticClosureSha256": [
          "sha256:8c5c63449663d84dffafcbf7ce250ef42b23b42aa90dc585d4bcbf21c96eea7a",
          "sha256:09a65aebd8cb4622be91392395abbd5072c6a7b00994c01c5ab79b68fd048c0a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_empty_trust_installation_rejected",
        "semanticClosureSha256": [
          "sha256:d98bb962218234afd3c3b6ab566e5f67bbefafc57b8261edb54ee617e0a7555a",
          "sha256:1b2fe5a39530d0ca14cc8752970c732e6309d248fd071b48b7ba5a8f8dd897b3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_entry_id_reuse_rejected",
        "semanticClosureSha256": [
          "sha256:9d956777f5064deff4a3d92b72909bc5d02cbb733fe98f09e17ffaa09b89fad5",
          "sha256:10749d8259a564364f359f8763f2e269823a015e4827d1a1740fbad4b520f66b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_equal_pin_current_merge_heads",
        "semanticClosureSha256": [
          "sha256:e24ace9e5a38f3d17ac59764e72747d4932a8aa1f18357665235abc6a4d488a2",
          "sha256:368a552a3b170fe6b38cbdd0c14f6c020a8bad155a789d1a6ed1b8a1a33b67c9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_exact_mediated_run_reservation",
        "semanticClosureSha256": [
          "sha256:9da8d47d833ab9846521983724f59bef173f836a660ee27d80573fbe327659c6",
          "sha256:6dc618698c3d3622ee9900dcf8a6edb196a040277b7eb03ea17b77fd03d2578d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_exact_remote_reservation_epoch",
        "semanticClosureSha256": [
          "sha256:50ca7a0d1f6b1673a31551d0267aa3a196db47dbfc491ee05a962f8414a56b89",
          "sha256:5a20d41fe5a24747d50c2d6da443d06c2378f91966c26223ea67b35d0e4d2263"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_exact_route_projection",
        "semanticClosureSha256": [
          "sha256:d915b772afa628ab5671aeebcdf4ffed77a2668eeb58abc988031018f7f80808",
          "sha256:4cec0f36d8690064a28100c732b1fe4a57cc3e3eb48a26d1da2b881a942b3b76"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_expired_held_turn_blocks_undo",
        "semanticClosureSha256": [
          "sha256:00356ab26784ce3c22cc726751ed7694184c0ac6fd4dfbc65762344f6ef5d562",
          "sha256:5e21bb681411f68a12a78160a4876b20b880a9e9731f86fd5a039657c1671b7f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_expired_permit_cannot_consume",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_failed_retry",
        "semanticClosureSha256": [
          "sha256:16d41e84f7a624b733b7c541e27498c2e3eb90c21e3b501b067dacf711fc586f",
          "sha256:4baab790666bf60d1944db7ed43274a9eba5f23c39011ab957840dd57cbe1221"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_fenced_undo_redo_trace",
        "semanticClosureSha256": [
          "sha256:c69dff8ae763675162b1fc21b20fa85b4ad146e490ff8daccbddce1640c96281",
          "sha256:8b0988751fab3392c42ab16908e3cbcfc23e1895b2debc2e3f47c8306eab6132"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_forced_sibling_system_fence",
        "semanticClosureSha256": [
          "sha256:38288a927465f7aae0c021cb05dcb764276db22201cda3753716ecbaf0f0a512",
          "sha256:f59f553d160e9b9ee44f8199e64526bc3df5a75656c03adc8c437d6f5ea561bd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_foreign_guest_deny",
        "semanticClosureSha256": [
          "sha256:b59a918c25dd882b59cd1f58451de6d0481fc3e51a5e828083582f31399fcca4",
          "sha256:59564bcf9738098b9347de9c091356ddd5c032cb8d340e923c9301c599c05f9f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_foreign_verifier_verdict_rejected",
        "semanticClosureSha256": [
          "sha256:cafe7e8ace221bf7afe29d148220b2cbd68425c209a718fd5a28ab61ae5deb0b",
          "sha256:5c01e23eeed01d0f135f727472f22c32f355e59c9deec468e3533cc5117ea487"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_gate_band_dominates_and_refuses_rewrite",
        "semanticClosureSha256": [
          "sha256:f376782924e9c35e2b2293a6f45d4cc53f5b7a140977ad6c397c26f276d51cdd",
          "sha256:12f5a552f00a30d2fffe914db9df3cf1d8cd8719f67db49c2dcc9430ebdd8cb2"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_glob_covering_admits_narrowing",
        "semanticClosureSha256": [
          "sha256:eb4baeac9c9a9ff91ee68325a81665c1571d2062335f66ccdaa32beb142cca67",
          "sha256:b8bed9f39a050e3cca31f0b44ee51e0f2f756bb55e534a0710d00906e02a808e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_glob_covering_refuses_widening",
        "semanticClosureSha256": [
          "sha256:eb4baeac9c9a9ff91ee68325a81665c1571d2062335f66ccdaa32beb142cca67",
          "sha256:b8bed9f39a050e3cca31f0b44ee51e0f2f756bb55e534a0710d00906e02a808e"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_glob_match_discriminates",
        "semanticClosureSha256": [
          "sha256:5190c6a377ab1db8c8b96432e2a4fb7c58469412f18e43a253d8e1bb39e13420",
          "sha256:0fa28db7f87499d62d37732b815152fc714e5aba805acfa2cfcd9c5c73b253da"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_graph_freshness_rejection",
        "semanticClosureSha256": [
          "sha256:0b86af32572520c0d6c80ef44fce4953d26baf0cbfb592e36b968e6696151ead",
          "sha256:63ec7e91c45c36816d3704adacd99667ce1561f5449d5725a961f872075018a3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_guarded_attempt_reachability",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_guest_and_cross_tenant_carriers_are_refs_and_leaks_are_unreachable",
        "semanticClosureSha256": [
          "sha256:2a69d11179d6ee2faba99e5698e0edddd8ae150d204f9c1dd0b7ef7b97f1a774",
          "sha256:e740745efec673d06fd4d0b38747415a4488299da4de92df38c036011ed5be10"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_guest_elevated_allow_filtered",
        "semanticClosureSha256": [
          "sha256:e4fd8a887d530eccae13ae7e7b182d00cfd4e65a7e33b33a3c7bc5326cc8d38c",
          "sha256:5df856d64acf65347bb7e256812f3290051c58ac1194d68f7a4d741dab36a9bd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_handshake_guest_materialization_refused",
        "semanticClosureSha256": [
          "sha256:a9ca95979a65a0cb0c717d7b4a6ec1ea10f125752644fb19ab825631bc437001",
          "sha256:ee3d6508e5e7561a9ecd4c739c2271f84aad1b61222a559852ace59d7e9c8b78"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_holder_watermark_inequality",
        "semanticClosureSha256": [
          "sha256:206b17f549b00b64e73d52780934ab4feb2020c37d8b87291d37ea26902c91cc",
          "sha256:e4b0c7d34266bda44a132c9001c82f0c095de1b38c4b4ad8a886b968272e7281"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_hostile_tier_publication_rejected",
        "semanticClosureSha256": [
          "sha256:e795e1495c512c2d8cdcdc9ebadf2d3b08973f4ff21cb5bac3fe9bea79087419",
          "sha256:d9ef96cdce92dfea2129889b18f7049c8af22d5504bd3b3e91909e273f007f2e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_indeterminate_batch_current_not_terminal",
        "semanticClosureSha256": [
          "sha256:62b42409650bd858f81349a242b17c11cb86ab9f428b1eb8f18e6e07941346b7",
          "sha256:e30bf67a214f4e06a9d8d5953be1186f4c1096284ead17395bc01743bcc536f2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_intercepted_observe_escalates_to_mediated",
        "semanticClosureSha256": [
          "sha256:f4b61109e3cf48cd859b82c072e43aaee8c17c151a057825aece1b6c43702233",
          "sha256:f97de182e3e3efda465655870bb9013d6bebf8ed23a522c82cbe01ee50fc5393"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_interception_pipeline_run",
        "semanticClosureSha256": [
          "sha256:16f86e8a8519a581b62ec5e4dcde4705f48a2fd8f1e788da6051f5443418a0e1",
          "sha256:84bd650828f3aea4443dd6fe28db43d5e480bc1341d5f525728d7220a6717afb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInterceptorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_interception_replay_item_bridge",
        "semanticClosureSha256": [
          "sha256:6edd649df0fa3962fc813061bc26722afe5e08541f7f78016b753195a0e8b49b",
          "sha256:ca8c4281ae1fd0e23fbddd42e9b166d829bb971ade69905d562f496aa1b70eba"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_interceptor_block_scoped_and_final",
        "semanticClosureSha256": [
          "sha256:9f09a4ade6e29c6795231ac22d4e20582d1a344479808576637af56610e4318e",
          "sha256:664ab0bad4bef2f15b16af66f1cc24ed8a4786ba40a4248ac9155220c0b78b40"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInterceptorRef.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_invalid_arguments_invocation_rejected",
        "semanticClosureSha256": [
          "sha256:755d0e39987b615795388e0037aac85705b2201a153c6eb72329e6a4a714510d",
          "sha256:dbcddcdfd31d4d7f586055734b8a99d891aff810a9b13da9d02548d99530af3b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_invalid_migration_target_rejected",
        "semanticClosureSha256": [
          "sha256:aedab7f42b86daf7ad785053072addbd909a968c6edd1cd63c04a983f6f15798",
          "sha256:984c888cdabb4e1eb9687760b4b473c3f5d19a842b25b3bdc81f11119febcdb4"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_lease_exec_reclaim",
        "semanticClosureSha256": [
          "sha256:3f63c33358fc0fa81b5887d611a9e2f594bbe1b4c88bd257fa2be7f7ce9d3355",
          "sha256:2cc2148181a3de7d9eaef657ba53a364c4604b97cb4d43b8512111a8ef3d6e1b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_live_deny_override",
        "semanticClosureSha256": [
          "sha256:5bdea28b09f27c67f5dc3a93e4a294b22f09bdf92506a16b491a9096773dcdf1",
          "sha256:44e45d43313da906e4602557a3334bc0a3e5d10bb63f341fb31d7be45d634645"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_live_self_event",
        "semanticClosureSha256": [
          "sha256:6f9513534a792fede71f892a6d456b8b327465dd1e82daa9661c6477be7a9dad",
          "sha256:16e563cd695411127a67f87c4dff9dec7d55cf58625662922bb2466b77bd522e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_malformed_approval_continuation_rejected",
        "semanticClosureSha256": [
          "sha256:93f59dbc6918437bd1b89285e4b96d9dfb6adf9efe76b8ddc94501f3a776050e",
          "sha256:d6f68c41f93bd254d4ed21307c636299241f5c412f8cf2b0af83c5d8a0f73da9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_materialize_then_reconcile_never_duplicates",
        "semanticClosureSha256": [
          "sha256:bc55f43a8cee9d1b363a8d3408a24ebf858d1d2e5db9966d0a02b3f43043e167",
          "sha256:3a06841aef6b496b174d1df07ba40b2b7654f7398bb1bd6ddafbb77a13ae6104"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBlueprintId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionTemplateName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_migrated_old_turn_rejected",
        "semanticClosureSha256": [
          "sha256:b7755b6e7cfbffcf96cb48c58e05d7302cd7ab92844f2c3525d6e1474b16714b",
          "sha256:58d5defff12549a1aedf175382f660ff190ead3914d9372f54063566b3c816a5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_mismatched_custody_resolution_rejected",
        "semanticClosureSha256": [
          "sha256:012d670697c6ea881f20e7aa62926d9fb6f7f5f4fbc092a2dcd9c5af91902f1d",
          "sha256:42073296bdb5d852c34b1138d30c999e5af9d4fe3a45502c9a8a105e1f2d6d0a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_missing_content_resolution_rejected",
        "semanticClosureSha256": [
          "sha256:a93df1b61d05e71d7d450878f5e6e06a461154a16d04886a86f2f9ef916beda6",
          "sha256:87984f477909749ce916d174ffa0f94fb95ee15d76c7939507778cb312a24b28"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqContentRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRecordId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_missing_target_request_authentication_fails_closed",
        "semanticClosureSha256": [
          "sha256:539c6d9eaf1eff17f51f0d22b1462a7638552407f7de3e6117f784cf75e70c84",
          "sha256:fa9e79b7c1b30710d5992d7c242b3668c7b5ba245fe794280180379bfbea353d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_mixed_batch_partial",
        "semanticClosureSha256": [
          "sha256:bc1d46ed1303b24d34ae145904db218c4bccd5caf5328049f8a69ad6901b678a",
          "sha256:9c9c646f0a4bf0351952795226f4f5a5e85756446e543e53603ad88162b0cae4"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_nonderived_route_rejected",
        "semanticClosureSha256": [
          "sha256:39a660e290481d60d921d8cabaf49e50d2d4f363617ed8c81b4b2d8e27205249",
          "sha256:270996d29b6a99a7956e0dd3c4e099d72f257299674f25a6e0399eeaaedf7818"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_nonempty_audit_terminal_snapshot",
        "semanticClosureSha256": [
          "sha256:c658edff187bf5c0c4a5a70614597f3145d947ff90068ab0e6b022d9c8705bb7",
          "sha256:1866bc3d54ce04fa727fa6f3e6fdf7a75827faf4c52cc22a117a9623ff7e5be4"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_nonroot_cause_free_append_impossible",
        "semanticClosureSha256": [
          "sha256:7ee585200952b581579e1d6133b304a5eac287518ae4168c4697227e8558288f",
          "sha256:35fc042a639f70e74ccb67f8e3dee9e8fe643e02753e769a67aa273f91028fa6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_nonvalidating_contribution_rejected",
        "semanticClosureSha256": [
          "sha256:809f0424836e42e9b14ece6d17e52783072a3ff59717d29bddf40b803f3a4771",
          "sha256:6ab7da4e3cce40cd4dbd05999e9995dec7fcb1839a780af1513696d449a3fc55"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_occupied_command_id_installation_rejected",
        "semanticClosureSha256": [
          "sha256:755d0e39987b615795388e0037aac85705b2201a153c6eb72329e6a4a714510d",
          "sha256:dbcddcdfd31d4d7f586055734b8a99d891aff810a9b13da9d02548d99530af3b"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_optional_turn_owner_audit",
        "semanticClosureSha256": [
          "sha256:9047e7eef27447f942e303b1bf79edb000e8c61841fbeb93cf802257b2bbe8f8",
          "sha256:87f20d973ffcbee0248458e15322f34e2f460d6d42caf02bdd362a3636c8bca9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_persisted_approval_continuation",
        "semanticClosureSha256": [
          "sha256:2f4b77cb15feb94abb005f2274c3d407ee82210ee9682296ca81449caef96d5a",
          "sha256:2ad399ac64315cc67ff38ca3be35754091a0ea955a83be79670bc62bd3eb53cb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_pinned_root_writer",
        "semanticClosureSha256": [
          "sha256:dbc89f462e732cae7b0aa4d26950ef18928834c9eea11661674995c6dbee161f",
          "sha256:0d15b7cd1ddfec5934e81bb74456ec1f6e8e6fd4dbcd5ee09a2c1916ca2985bb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_plaintext_session_state_unreachable",
        "semanticClosureSha256": [
          "sha256:b266568a369b4ed4178d76cf27ff3fa329794facfe28110a3af9b4d8377d5159",
          "sha256:a371ce71aba89c1242e176ed0fa7acb085a6f166bb6df1a35d42bc347d49a7e9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_preview_exposure_lifecycle",
        "semanticClosureSha256": [
          "sha256:1f725096144ea6e3708be83b3ec737c387b92469eb4e3efdda1258562a0503b4",
          "sha256:36d06c2dad59511b827793a16bd28fa0d773aa180744817232808055b8359a33"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_projection_reservation_bridge",
        "semanticClosureSha256": [
          "sha256:894c44e5fd149b00a60df5a5c0674c3ed1f195e7114143c14b142574efdc42da",
          "sha256:0de7e1a5936d694dd8d376151218d1557f9a3da9d1a91e4853cc323e5d1640ef"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_prompt_slot_authority_gate",
        "semanticClosureSha256": [
          "sha256:d6811ab0cc122c6a0bd5934c54edb5a6c6bf160412fad9c126aa1c4e77e6837a",
          "sha256:4d0394b6c94385e256dfbc0e34b373459384b96da1371aaa65bc99cdf0695383"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_reachable_route_reservation_consistent",
        "semanticClosureSha256": [
          "sha256:f1d5fbc6297f1a48c3f9da661d7cfcb9d2e556740d5b13e09a6300a3d3dc0c45",
          "sha256:2e7e691b5ce2f062fb6203904e2430cfcf95b372c1314a09a5a5f8293e960cf2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_reachable_settled_obligations_and_acceptance",
        "semanticClosureSha256": [
          "sha256:66baa932f2d7fa68cc97b399aa6ab35b5cd9fdf92d363a2a55dd6892dec4b2b0",
          "sha256:f2810335331a81dc49036d0174926885450adb56383c39bc83cff40e6739b261"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_reachable_settled_run",
        "semanticClosureSha256": [
          "sha256:45e1931385b83790a11659db17d20784a988e5ae7f7242f480061309c53be993",
          "sha256:4bda062e38f3d975223c8f8d762bb0183a91a7d8ae12f84424d580786b4595dd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_reachable_stale_verdict_not_settled",
        "semanticClosureSha256": [
          "sha256:d647a8a25410b2b02ee2e0ec4471c86afbbc0697bae79192aec8c7c6cf7c7dc1",
          "sha256:3f3e92c9cc46f3c026cb85c832c6c5f0e95349e01e7b797bd1314db606083bfa"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_receipt_audit_append",
        "semanticClosureSha256": [
          "sha256:75301f1cc353366968bad54b7b153cfd8ae4fe403c3d073b788c7c50f6872193",
          "sha256:7caa4e92f06055ccfa7468524270e90548e0872b66dbd0be0f1372b33f360224"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_receipt_id_disjointness_rejection",
        "semanticClosureSha256": [
          "sha256:b3746ef62f937f2a31da23a090a2c3444db9c37859f7ae4c6ecf4811bfd1c409",
          "sha256:166ba635eec7f6faa0ded1624ca43cd6321a054afa31c3ad5761e33d95fed4f5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_redelivery_is_inert",
        "semanticClosureSha256": [
          "sha256:1ba465d40c8c29079753787e22ae89b4def867f82f72c120d446b8e9ff6ca5bb",
          "sha256:afd66b71d5fc01ca636cbf86386f55e985a69d4a094283bc8647e316825b3ac2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_redelivery_of_route_reservation_rejected",
        "semanticClosureSha256": [
          "sha256:48096ec4d31220edfdf28f01f128d3a8c203e2987b3dbc43fb1e078a123999ec",
          "sha256:36e29360a9a4a9fef1a55bd29239bf2295d14f4a11927120ffc42c8b7e03d88d"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_registry_nonempty_and_completed_frontiers",
        "semanticClosureSha256": [
          "sha256:a9f3d771f4e7bf8b0a3439cfdcc3602e66e4565bfb3e6470684958edcadcb9b8",
          "sha256:51c23fe3cf2b812cc889e86e9287accac98b88171865fc93d56751130a599688"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_request_approve_start_trace",
        "semanticClosureSha256": [
          "sha256:2f80533347cc615f989bc5a408269fe937f6feee75e5dfb9c75a32672db09e4b",
          "sha256:9d3f62c6683f5485cb65d7f59e76c92977ee2bd1b05652c049179d9b0570865a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_reserved_identity_recommit_rejected",
        "semanticClosureSha256": [
          "sha256:543a939a3f819695957a768a6958a39eddd351d3adb4c4d21cc5eecd19c77d95",
          "sha256:c1be3c9c8ce9c6d1fa295e6103b04fdf2aeb472eb3bef12534b26b4aca78ef5f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionCaller.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionIdentity.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubmissionWriteId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_reset_auth",
        "semanticClosureSha256": [
          "sha256:f8fea50603dbd4edcfd1479b8a7b9d2f1523a65380be1e9c62a44fb8b1c9e96a",
          "sha256:4b84b2779bb751145e5c5e175a472d18a320350528d539dabf1227a19d937cc5"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPermitNonce.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_resolution_reorders_arrivals",
        "semanticClosureSha256": [
          "sha256:3e4c9fce118bc0061b6de6294632b7fdaf760ee51a4d88aceb8cd7bc53f2014e",
          "sha256:ad8e4288b45ab478bede421ad4708b70a88787aba37a9dc8726b85c294ca6837"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_role_rematerialization_epoch",
        "semanticClosureSha256": [
          "sha256:decfbf45070661489d0e2e9296e9d1582bcd6bdbe750fcd7da405f2185eae269",
          "sha256:a6a1c64d3798628d90728741ae6a1dedc442571347ba49a3c9898e0ec9ebffca"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_route_delivery",
        "semanticClosureSha256": [
          "sha256:6c8319a6dc6534cac453c01f245743e8d46ef704997d6887312bd08ee9c906d0",
          "sha256:594c20e3358b038e30dc217d149e7da4390edcfbfa802131904de556d32d7fb2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_run_admission_completion",
        "semanticClosureSha256": [
          "sha256:4f5fd26573db40303c5c21e0de96b774e56cb28d695b0d6fe47f5d5ea06ee930",
          "sha256:c49f49f216bdfdd68dffa36e55d3640d9de9991fb43366b017ae8187919d95fd"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_run_admission_reservation",
        "semanticClosureSha256": [
          "sha256:9b4d5b66aaf07ba680f1c705973272d9b1d9e349dff2266eddc5e6efec31ad04",
          "sha256:83c1c82bb2fa0c79cd231e869cb3242e3191113d1d581da52d6156282cbe79b6"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_same_attempt_supersession",
        "semanticClosureSha256": [
          "sha256:2da404a1d061a07247fc32bfb6ce6f9ba84b3bf195c1ed9116063a4622685f3a",
          "sha256:ce616d695121485f3000de80049c23af485a79a07a8f11aae0f8991e1f414ff9"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_same_event_never_refires",
        "semanticClosureSha256": [
          "sha256:ef592d0d6bf8b7270fbd9ad0d09d0526a4b41e070a3c92a7a79cc94118e7e890",
          "sha256:e7d8f51f6ee468d9928d6692179d9dcf782317e5f0cbf96f734a1be79e361390"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_secret_custody_exact_and_repoint_invalidates",
        "semanticClosureSha256": [
          "sha256:6d8541fa43830a1436a567ff0190f0e78ba9e58a30c52fbe0da82fe99eed33e1",
          "sha256:8ccf9fa74d04512df12ac659a5bea8c23ca7bbae2a8d01cc812329b669be9f59"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_secret_delegation_carrier_is_ref_and_leak_is_unreachable",
        "semanticClosureSha256": [
          "sha256:614f4dec89182ca8b77571190e301b0e6aee6e43535b73985cf7e766d8251cc5",
          "sha256:ccebbddf636f12096cda1f43106e5e816de297c5f77402cf95721fb5eb028915"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqDelegationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGuestGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSecretRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_settled_acceptance_holds_at_current_head",
        "semanticClosureSha256": [
          "sha256:274fcbf0426683aedd254138dd1335f94352bce85a4664d1aa7d9105f9303416",
          "sha256:f5fd91cfc02630e24720544ed6793a874aa0c78e12a6626c115fd2941f0adf2f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_slate_lifecycle",
        "semanticClosureSha256": [
          "sha256:a192fa6c8fe018223c468304f0e2832a3b4e3281a87ecbcd9bdfe91126ced409",
          "sha256:1ce536079b3c365860efcde930d98e832708fa494b8f8d0683b3d7935a7e04f1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateDeploymentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePreviewId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlatePublicationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlateVersionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_slot_contribution_lifecycle",
        "semanticClosureSha256": [
          "sha256:fcf7575b00246eb610784ffc7cdc54071b8b2e81220d14d9904479e68ae184df",
          "sha256:8703e8e4855f7b021b43c78b5c38a69197ccbfeb1eb567d1b4607a028ccffb8f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_slot_noop_reinstallation",
        "semanticClosureSha256": [
          "sha256:b7e070286d0cfc999996752677c362ef9c1da20e01b7424ce59b642451f1c126",
          "sha256:daff92926b8ff9bb2fd9ecbcb0fe725cad4dbea983ef3d65ed898c8ab6691a73"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_slot_redeclaration_rejected",
        "semanticClosureSha256": [
          "sha256:667b6e27b9545c6cf2856e640c605ff829a6baed26ba6acca6c3cb0830b5904d",
          "sha256:54eae231421b76ea908330f05daf5596b5b6240dbfbd464d86c58ba7c0390ca2"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_source_reservation_audit_binding",
        "semanticClosureSha256": [
          "sha256:a6136e9791570250f2dd06a7062a039e9f9f1a175032571a4f4d1a5e7f21bae0",
          "sha256:170c19f8da59469d6989938c1402849e5265f86d4e3f7af921978806117d3e3f"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_stale_and_closed_session_rejection",
        "semanticClosureSha256": [
          "sha256:95214cb43adcf716f24c904b82ef4473e4da6f3ed50176edf611e025dfee8778",
          "sha256:bb4a1814fa0aa8d5e54f16c9a655744a0c4ad2ec04f70e4bae54dce7b29b2b17"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEnvironmentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqExposureId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSessionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSnapshotId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_stale_denial_audit_atomic",
        "semanticClosureSha256": [
          "sha256:64032ec84c8bdf4d77986e92ef8ade8217a029a162c2bfe1bd62993893239c47",
          "sha256:f87094c9fdc4406cf111871e7181b5222baa3821074f9af58119b7b5efa274f3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_stale_mediated_denial",
        "semanticClosureSha256": [
          "sha256:b308882f464a6a7711c9efa85370dbd88d19bd0b38960c8102f9adcc7c121e1b",
          "sha256:b6e8f931ecf2d7b352fda0ecdb61ca72108d4cd8ce7092eb4154c212c9f8b921"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqGrantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemClaimId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqMembershipId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResolutionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_subscription_fires",
        "semanticClosureSha256": [
          "sha256:ef592d0d6bf8b7270fbd9ad0d09d0526a4b41e070a3c92a7a79cc94118e7e890",
          "sha256:e7d8f51f6ee468d9928d6692179d9dcf782317e5f0cbf96f734a1be79e361390"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSubscriptionId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_system_synthesis_writer",
        "semanticClosureSha256": [
          "sha256:13f78e5e8de3015564b287897e8238d51a45bdc1964502c5f2f52c604b41d186",
          "sha256:4703e8945cad797d5ec29bd50d207d1b400cea700ccfef20bf14aa9f8ac47e4e"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_tampered_interception_replay_refused",
        "semanticClosureSha256": [
          "sha256:72b8ca2cd6a65cdfd17db5eb01f5f22ce9267dbd0ee25f2fa5f7a23577eb8aa6",
          "sha256:7b372a89be9b3398ed1b0915b446ab57dbcad0117ce352299c47136b1a7b49fb"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_turn_owned_execute_tier",
        "semanticClosureSha256": [
          "sha256:de0c4f07ed4e4555fc88dc42800c0ab3d48cae6157d7cccb558ac7e11c4ab5bb",
          "sha256:69183379fff0ecb0b4faa5bebcddcd8d61458c11146449622aebdbc854f94f78"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_typed_system_writer_audit",
        "semanticClosureSha256": [
          "sha256:bd07c925143901a29378477613feac0cb99cc1cf08bc3183b57612a54fc5b6d5",
          "sha256:56a823c38a3e67ad3c3677fc9a5970a71cec3754c56fecaac6e8d020320517e3"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_unary_commit_pin_inheritance",
        "semanticClosureSha256": [
          "sha256:795ab1ae8a1a01c77c5e6f80bf9d66d3018bc1558d25def9464ef569e93bbd94",
          "sha256:07802256c9d08acd7035e9a241c83e1b57bee652ca60e10261328307a8da9ee1"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_unauthorized_interceptor_never_attributed",
        "semanticClosureSha256": [
          "sha256:eea7cba5c054b2709242da880ac7434144445e5f6cf68857a5a99e6b0110cfbf",
          "sha256:90f10cdd50f8459e71626a300aa16d8f4c9d4b9616b90b99569d3eac5f5358c7"
        ],
        "lost": [],
        "gained": []
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_undo_selects_ancestor_and_redo_restores",
        "semanticClosureSha256": [
          "sha256:dd1e0ee2eb3fd4df032a55a6922c8dc9ac792bd8420d19bbcdfb180749fe2bbf",
          "sha256:be288e84f4d6531c23688bd4369f12194ac942d6da38d946811fd9901fdac555"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_unheld_nonterminal_sibling_rejected",
        "semanticClosureSha256": [
          "sha256:1eedff66b3ef48666cae3e8fa0a3b970462c25c3146230bba487d31fa99f24a4",
          "sha256:8250b99038a3910188c60c51b818ef2ff2842f4d711f543bca0b747f923b1f6a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAgentId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqApprovalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuthoritySource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBindingId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCallerEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationHeader.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqItemKey.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqLeaseToken.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOpenObligation.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqOperationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPathEpoch.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPayloadShape.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSet.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPlacementSnapshot.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqPrincipalRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProtectionDomain.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqResource.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRouteEvidence.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqStructuralValue.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_uninstalled_contribution_rejected",
        "semanticClosureSha256": [
          "sha256:0e18a5ccdd5910cf0862ad9460fc06f2e053d8df5b1c32bc3d28df4e3c7e7f09",
          "sha256:2133ff5a11da9668fbc59f824e311e28cea7604abb328abd5d9645e41d72e685"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_uninstalled_invocation_rejected",
        "semanticClosureSha256": [
          "sha256:9d1c864a667919b79e59e30c54876a16fb0641e451c441ae148645c2f542c607",
          "sha256:21b1ba9ed3375863c84fee4bef1fde6b671e6e816d49f50bc083a2e515abd0ea"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_unprojected_route_delivery_rejected",
        "semanticClosureSha256": [
          "sha256:e34b3bf6a2837712c035e5e639d02c35280a1d26ef0ff9fa882374f4586f8e34",
          "sha256:d14728d2a5c8b3584b896dbb819d9cd277b0d95336a9e38e9696a5e7bf9c011a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqEventId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectionId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReservationId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_unsafe_mapping_installation_rejected",
        "semanticClosureSha256": [
          "sha256:8a302d3cf81e40423f2be9ab348e76c15f4cccc9b58e6c1524c73e5ed69ffa71",
          "sha256:944c48c2eaf7073033c8e6d7a3d0e3451cc132bde9fe4ef77f13a33e630d995a"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqCommandId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommandName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqFacetId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqProjectId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqScope.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqSlotName.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_unsatisfied_acceptance_blocks_settled",
        "semanticClosureSha256": [
          "sha256:35a7de9b3d5b864b430f00e5bac2f8040bd2bc01feb525c943e9eefea83205bd",
          "sha256:b91bf4ff1be4e4c6a7155bccfe4061e62fa22534b19e957dc9e3bb11e830bb63"
        ],
        "lost": [],
        "gained": [
          {
            "name": "AgentCore.instDecidableEqAcceptanceId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqActorRef.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAttemptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqAuditId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqBranchId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqCommitId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqInvocationId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqReceiptId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqRunId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTenantId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqTurnId.decEq",
            "class": "authored"
          },
          {
            "name": "AgentCore.instDecidableEqWorkspaceId.decEq",
            "class": "authored"
          }
        ]
      },
      {
        "designation": "witness:AgentCore.Examples.nonvacuous_view_replay",
        "semanticClosureSha256": [
          "sha256:f410f07ddf5bb4b71f30967979a604fb95411a729d324292c21d9b709b82e503",
          "sha256:c109749771c206873cfc674efe19611086d0f70cc9ac4edafaeb25ab20ee9f55"
        ],
        "lost": [],
        "gained": []
      }
    ]
  },
  "semanticClosuresCounts": [
    402,
    402
  ]
}
```

## Classification of deltas

- Schema: one current identity only. Both sides carry `encoding: "agent-core-lean-structure-sourced-closure"`. The strict checker accepts this exact field/value and rejects the retired `encodingVersion` field.

- Designation plane: name and kind sets match exactly, 632 -> 632. Every allowedAxioms value in all 97 deltas sits inside the closed allowlist {propext, Classical.choice, Quot.sound}. See `allAxiomValuesWithinAllowlist: true`.

- Type hash deltas: 10, in two clusters.

Cluster A - source-migrated alias, 7 designations. The statements replaced deprecated `String.data` with `String.toList`. These constants have equal bodies, so each proposition is unchanged while its encoded constant names differ: foreign_subject_key_separates_verification_schemes; nonvacuous_canonical_subject_key_separates_schemes; nonvacuous_canonical_encoding_discriminates; nonvacuous_glob_match_discriminates; nonvacuous_glob_covering_refuses_widening; nonvacuous_glob_covering_admits_narrowing; nonvacuous_pattern_validity_discriminates.

Cluster B - elaboration artifacts, 3 designations: guest_allow_is_attenuated, guest_deny_is_preserved, stale_mediated_denial_matches_intent. Their statement text has zero diff. Type encodings shift through compiler-generated references in decide positions. Axiom profiles shift through new simp and Iff normalization paths.

- Allowed-axioms census: propext gained 48 / dropped 0. Quot.sound gained 9 / dropped 9. Classical.choice gained 39 / dropped 0. 48 designations moved from an empty profile to a non-empty one.

- Closure members are classified from authoritative origin markers emitted by the encoder (findDeclarationRangesCore? with one privateToUserName fallback), never from name patterns. Per-designation member sets are resolved from both locks and compared even when the recorded closure hash matches.

- Closure deltas: 532. Member classes: authored 0 lost / 5868 gained; toolchain-shape non-materialization 20 lost across 10 authority designations. Unclassified: 0 (exit 1 gate).

The toolchain-shape case is exact: instDecidableEqAuthorityGrant and instDecidableEqCapability are sourced in the base manifest, absent from the head manifest, and their semantic content is carried by the recorded .decEq workers that appear as authored gains in the same ten claims. Nothing else lost a source definition without a matching gain or an enumerated explanation.

- Declarations manifest: 2713 -> 2791. Shared names with changed sha: 155; their value encodings cite renamed auxiliaries.

## Planted negatives

scripts/quality/formal-negative-probes.mjs edits a tracked file, runs the target gate, requires a nonzero exit matching the intended rejection, then restores bytes (sha-verified). Six probes: designation deletion; witness-family deletion; sorry injection; native_decide forbidden axiom; semantic mutation behind an internal artifact (check-normative); one-designation closure mutation (parity auditor). All six red for their intended reasons at this tip; harness exits nonzero on any miss.

## Reproduction

```bash
node packages/agent-core/scripts/quality/lock-parity-audit.mjs \
  ~/agent-core-context/formal-closure/base-normative-v4160.lock HEAD > parity.json
node packages/agent-core/scripts/quality/formal-negative-probes.mjs
pnpm --filter @agent-core/core check:normative && pnpm --filter @agent-core/core check:traceability
```

Base artifact: ~/agent-core-context/formal-closure/base-normative-v4160.lock, regenerated under leanprover/lean4:v4.16.0 with the sourced-closure encoder and strict checker; sha256 recorded in generation-command.txt beside it. It is a review input only and is not committed under packages/.
