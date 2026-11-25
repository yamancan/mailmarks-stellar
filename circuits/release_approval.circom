pragma circom 2.2.3;

// The deployed circuit: the sender constant of docs/template.md (mintmarks@trionlabs.dev, 23 bytes below). 960 is the
// padded buffer's capacity (15 SHA blocks): the signed header is at most 951 bytes, since 952 bytes need a 16th block
// (decided 20 Nov: 960, not 1024, whose 16th block EmailVerifier's 10-bit length check never lets in).
// test/deployed.test.js compiles this file and checks the sender.
include "./approval.circom";

component main = ReleaseApproval(960, 64, 23, [109, 105, 110, 116, 109, 97, 114, 107, 115, 64, 116, 114, 105, 111, 110, 108, 97, 98, 115, 46, 100, 101, 118]);
