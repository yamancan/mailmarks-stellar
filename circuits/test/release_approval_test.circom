pragma circom 2.2.3;

// Test instance: sender approver@mailmarks.test (docs/template.md), same sizes as release_approval.circom.
include "../approval.circom";

component main = ReleaseApproval(960, 64, 23, [97, 112, 112, 114, 111, 118, 101, 114, 64, 109, 97, 105, 108, 109, 97, 114, 107, 115, 46, 116, 101, 115, 116]);
