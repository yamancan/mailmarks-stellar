pragma circom 2.2.3;

// Release-approval circuit (docs/template.md, docs/circuit.md). One DKIM-signed email header proves:
// the signed From is exactly one mailbox equal to the sender constant, and the signed Subject is exactly
// "emailmark <project_id> <artifact_sha256> <wallet>". Fields are read at private offsets that the
// circuit checks itself; there is no free-form parsing and no zk-regex (docs/circuit.md explains why).

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "@zk-email/circuits/email-verifier.circom";
include "@zk-email/circuits/utils/array.circom";
include "@zk-email/circuits/utils/hash.circom";

/// at[p] = 1 when a header line starts at p (p == 0, or CRLF at p-2) and begins with pattern, letters in either
/// case (pattern letters are lowercase), so "From:" and "FROM:" count as well as "from:".
template LineStartsWith(maxLen, patLen, pattern) {
    signal input in[maxLen];
    signal output at[maxLen];

    signal eq[maxLen][patLen];
    signal eqLower[maxLen][patLen];
    signal eqUpper[maxLen][patLen];
    signal run[maxLen][patLen + 1];
    signal cr[maxLen];
    signal lf[maxLen];
    for (var p = 0; p < maxLen; p++) {
        if (p < 2) {
            cr[p] <== 0;
            lf[p] <== 0;
        }
        if (p == 0) {
            run[p][0] <== 1;
        } else if (p == 1) {
            run[p][0] <== 0;
        } else {
            cr[p] <== IsEqual()([in[p - 2], 13]);
            lf[p] <== IsEqual()([in[p - 1], 10]);
            run[p][0] <== cr[p] * lf[p];
        }
        for (var j = 0; j < patLen; j++) {
            if (p + j >= maxLen) {
                eqLower[p][j] <== 0;
                eqUpper[p][j] <== 0;
            } else if (pattern[j] >= 97 && pattern[j] <= 122) {
                eqLower[p][j] <== IsEqual()([in[p + j], pattern[j]]);
                eqUpper[p][j] <== IsEqual()([in[p + j], pattern[j] - 32]);
            } else {
                eqLower[p][j] <== IsEqual()([in[p + j], pattern[j]]);
                eqUpper[p][j] <== 0;
            }
            eq[p][j] <== eqLower[p][j] + eqUpper[p][j];
            run[p][j + 1] <== run[p][j] * eq[p][j];
        }
        at[p] <== run[p][patLen];
    }
}

/// 1 when lo <= c <= hi; c is a byte.
template InRange(lo, hi) {
    signal input c;
    signal output out;
    signal a <== GreaterEqThan(8)([c, lo]);
    signal b <== LessEqThan(8)([c, hi]);
    out <== a * b;
}

/// Display-name byte: [A-Za-z0-9], space, '.', ''', '_', '-' or '"'. No '@', ',', '<', '>', '(', ')', '=', '?', ':',
/// ';' or '\', so no address, list, comment or RFC 2047 encoded word can hide in the name.
template NameByte() {
    signal input c;
    signal output ok;
    signal output quote;
    signal upper <== InRange(65, 90)(c);
    signal lower <== InRange(97, 122)(c);
    signal digit <== InRange(48, 57)(c);
    var PUNCT[6] = [32, 46, 39, 95, 45, 34];
    signal punct[6];
    var sum = upper + lower + digit;
    for (var i = 0; i < 6; i++) {
        punct[i] <== IsEqual()([c, PUNCT[i]]);
        sum += punct[i];
    }
    ok <== sum;
    quote <== punct[5];
}

/// The byte after a line's CRLF is not SP or HTAB: the line is not folded, so no continuation hides after it.
template NotFolded() {
    signal input c;
    signal sp <== IsEqual()([c, 32]);
    signal tab <== IsEqual()([c, 9]);
    sp + tab === 0;
}

/// project_id byte: [a-z0-9], plus '-' when not first.
template ProjectByte(first) {
    signal input c;
    signal output ok;
    signal lower <== InRange(97, 122)(c);
    signal digit <== InRange(48, 57)(c);
    if (first == 1) {
        ok <== lower + digit;
    } else {
        signal hyphen <== IsEqual()([c, 45]);
        ok <== lower + digit + hyphen;
    }
}

/// Lowercase hex character to its value; fails on anything else.
template HexNibble() {
    signal input c;
    signal output out;
    signal digit <== InRange(48, 57)(c);
    signal letter <== InRange(97, 102)(c);
    digit + letter === 1;
    signal d <== digit * (c - 48);
    signal l <== letter * (c - 87);
    out <== d + l;
}

/// Strkey base32 character [A-Z2-7]; fails on anything else.
template Base32Char() {
    signal input c;
    signal upper <== InRange(65, 90)(c);
    signal digit <== InRange(50, 55)(c);
    upper + digit === 1;
}

/// a <= b for values below 2^16.
template AssertLessEq() {
    signal input a;
    signal input b;
    signal ok <== LessEqThan(16)([a, b]);
    ok === 1;
}

/// maxHeadersLength: padded signed-header buffer size (multiple of 64, at most 1024: EmailVerifier checks the padded length
/// in log2Ceil(maxHeadersLength) bits, so 960 holds 15 blocks and 1024 would add a block that can never be selected).
/// maxNameLength: longest From display name. sender: the sender address bytes (senderLength of them).
template ReleaseApproval(maxHeadersLength, maxNameLength, senderLength, sender) {
    var n = 121;
    var k = 17;
    var H = maxHeadersLength;

    signal input emailHeader[H];       // DKIM-canonicalized signed header buffer, SHA-padded
    signal input emailHeaderLength;    // padded length
    signal input pubkey[k];
    signal input signature[k];
    signal input headerLength;         // signed bytes before the SHA padding
    signal input fromIndex;            // index of "from:" in emailHeader
    signal input fromNameLength;       // display-name bytes before '<' (0 for a bare address)
    signal input fromAngle;            // 1: [name]<sender>, 0: bare sender
    signal input subjectIndex;         // index of "subject:" in emailHeader
    signal input projectLength;        // bytes of project_id

    // Public signals, in docs/template.md order (outputs become public.json in declaration order).
    signal output wallet0;
    signal output wallet1;
    signal output projectId;
    signal output artifactHi;
    signal output artifactLo;
    signal output dkimKeyHash;
    signal output nullifier;

    // DKIM: RSA-2048/SHA-256 over the header only (no body hash). RSAVerifier65537 range-checks the
    // signature limbs to n bits and enforces signature < modulus, so the signature has one encoding.
    component ev = EmailVerifier(H, 64, n, k, 1, 0, 0, 0);
    ev.emailHeader <== emailHeader;
    ev.emailHeaderLength <== emailHeaderLength;
    ev.pubkey <== pubkey;
    ev.signature <== signature;
    // RSA-2048 exactly: the top limb (bits 1936..2056) is below 2^112 and has bit 111 (bit 2047 of the modulus) set.
    signal topLimb[112] <== Num2Bits(112)(pubkey[k - 1]);
    topLimb[111] === 1;
    dkimKeyHash <== ev.pubkeyHash;
    nullifier <== PoseidonLarge(n, k)(signature);

    // headerLength is where the signed bytes end, and the buffer after it is the canonical SHA-256 padding:
    // 0x80, then zeros, then the length field (last 8 bytes, big-endian bits) equal to 8 * headerLength, in the
    // fewest blocks. emailHeaderLength is a multiple of 64 (zk-email Sha256General), so headerLength + 9 <=
    // emailHeaderLength <= headerLength + 72 picks the one shortest length. Every checked line must end before it.
    _ <== Num2Bits(log2Ceil(H))(headerLength);
    AssertLessEq()(headerLength + 9, emailHeaderLength);
    AssertLessEq()(emailHeaderLength, headerLength + 72);
    signal pad[64] <== VarShiftLeft(H, 64)(emailHeader, headerLength);
    pad[0] === 128;
    // pad[1..zeros] lie between the 0x80 and the length field; zeros is 0..63 by the two bounds above.
    signal zeros <== emailHeaderLength - headerLength - 9;
    signal beforeLen[64];
    for (var j = 1; j < 64; j++) {
        beforeLen[j] <== LessThan(7)([j, zeros + 1]);
        beforeLen[j] * pad[j] === 0;
    }
    signal lenField[8] <== VarShiftLeft(H, 8)(emailHeader, emailHeaderLength - 8);
    for (var i = 0; i < 6; i++) {
        lenField[i] === 0;
    }
    lenField[6] * 256 + lenField[7] === headerLength * 8;

    // Exactly one line starting "from:" and one starting "subject:", counted in either letter case (a capitalized
    // duplicate counts too), and the given indices point at them. The chosen lines must be lowercase, as relaxed
    // canonicalization writes them (checked on fw and sw below). A name with a space before ':' ("Subject :") is
    // removed by relaxed canonicalization, which the prover requires (docs/circuit.md).
    var FROM[5] = [102, 114, 111, 109, 58];
    var SUBJECT[8] = [115, 117, 98, 106, 101, 99, 116, 58];
    signal fromAt[H] <== LineStartsWith(H, 5, FROM)(emailHeader);
    signal subjectAt[H] <== LineStartsWith(H, 8, SUBJECT)(emailHeader);
    var fromCount = 0;
    var subjectCount = 0;
    for (var p = 0; p < H; p++) {
        fromCount += fromAt[p];
        subjectCount += subjectAt[p];
    }
    fromCount === 1;
    subjectCount === 1;
    signal fromHere <== ItemAtIndex(H)(fromAt, fromIndex);
    fromHere === 1;
    signal subjectHere <== ItemAtIndex(H)(subjectAt, subjectIndex);
    subjectHere === 1;

    // From value: "<sender>", "NAME<sender>" or "sender", then CRLF and no folded continuation. NAME keeps the
    // space before '<'.
    var FW = 5 + maxNameLength + senderLength + 5;
    signal fw[FW] <== VarShiftLeft(H, FW)(emailHeader, fromIndex);
    for (var j = 0; j < 5; j++) {
        fw[j] === FROM[j];
    }
    fromAngle * (1 - fromAngle) === 0;
    (1 - fromAngle) * fromNameLength === 0;
    _ <== Num2Bits(log2Ceil(maxNameLength + 1))(fromNameLength);
    AssertLessEq()(fromNameLength, maxNameLength);
    signal inName[maxNameLength];
    signal nameOk[maxNameLength];
    signal nameQuote[maxNameLength];
    signal quoteIn[maxNameLength];
    var quotes = 0;
    for (var j = 0; j < maxNameLength; j++) {
        inName[j] <== LessThan(16)([j, fromNameLength]);
        (nameOk[j], nameQuote[j]) <== NameByte()(fw[5 + j]);
        inName[j] * (1 - nameOk[j]) === 0;
        quoteIn[j] <== inName[j] * nameQuote[j];
        quotes += quoteIn[j];
    }
    // Quotes in NAME come in pairs: an unclosed '"' would put the address inside a quoted string.
    signal quoteBits[7] <== Num2Bits(7)(quotes);
    quoteBits[0] === 0;
    var TW = senderLength + 5;
    signal ft[TW] <== VarShiftLeft(FW, TW)(fw, 5 + fromNameLength);
    var ANGLED[TW];
    var BARE[TW];
    ANGLED[0] = 60;
    for (var j = 0; j < senderLength; j++) {
        ANGLED[j + 1] = sender[j];
        BARE[j] = sender[j];
    }
    ANGLED[senderLength + 1] = 62;
    ANGLED[senderLength + 2] = 13;
    ANGLED[senderLength + 3] = 10;
    BARE[senderLength] = 13;
    BARE[senderLength + 1] = 10;
    for (var t = 0; t < senderLength + 2; t++) {
        ft[t] === fromAngle * (ANGLED[t] - BARE[t]) + BARE[t];
    }
    for (var t = senderLength + 2; t < senderLength + 4; t++) {
        fromAngle * (ft[t] - ANGLED[t]) === 0;
    }
    signal fromNext <== ft[senderLength + 2] + fromAngle * (ft[senderLength + 4] - ft[senderLength + 2]);
    NotFolded()(fromNext);
    AssertLessEq()(fromIndex + 5 + fromNameLength + senderLength + 2 + 2 * fromAngle, headerLength);

    // Subject value: "emailmark " project " " 64 hex " " wallet(56) CRLF, and no folded continuation. The prefix is
    // shared/encode.js SUBJECT_PREFIX, byte for byte (lowercase only); every offset below follows from its length P.
    var P = 10;
    var PREFIX[P] = [101, 109, 97, 105, 108, 109, 97, 114, 107, 32];   // "emailmark "
    var SW = 8 + P + 31 + 125;
    signal sw[SW] <== VarShiftLeft(H, SW)(emailHeader, subjectIndex);
    for (var j = 0; j < 8; j++) {
        sw[j] === SUBJECT[j];
    }
    for (var j = 0; j < P; j++) {
        sw[8 + j] === PREFIX[j];
    }
    _ <== Num2Bits(5)(projectLength);                // <= 31
    signal projectEmpty <== IsZero()(projectLength);
    projectEmpty === 0;
    signal inProject[31];
    signal projectOk[31];
    signal projectByte[31];
    var project = 0;
    for (var j = 0; j < 31; j++) {
        inProject[j] <== LessThan(8)([j, projectLength]);
        projectOk[j] <== ProjectByte(j == 0 ? 1 : 0)(sw[8 + P + j]);
        inProject[j] * (1 - projectOk[j]) === 0;
        projectByte[j] <== inProject[j] * sw[8 + P + j];
        project += projectByte[j] * (256 ** (30 - j));
    }
    projectId <== project;

    signal st[125] <== VarShiftLeft(SW, 125)(sw, 8 + P + projectLength);
    st[0] === 32;
    st[65] === 32;
    st[66] === 71;      // 'G'
    st[122] === 13;
    st[123] === 10;
    NotFolded()(st[124]);
    signal nibble[64];
    var hi = 0;
    var lo = 0;
    for (var t = 0; t < 64; t++) {
        nibble[t] <== HexNibble()(st[1 + t]);
        if (t < 32) {
            hi += nibble[t] * (16 ** (31 - t));
        } else {
            lo += nibble[t] * (16 ** (63 - t));
        }
    }
    artifactHi <== hi;
    artifactLo <== lo;
    _ <== Num2Bits(128)(artifactHi);
    _ <== Num2Bits(128)(artifactLo);

    var w0 = 0;
    var w1 = 0;
    for (var t = 0; t < 56; t++) {
        Base32Char()(st[66 + t]);
        if (t < 31) {
            w0 += st[66 + t] * (256 ** (30 - t));
        } else {
            w1 += st[66 + t] * (256 ** (61 - t));
        }
    }
    wallet0 <== w0;
    wallet1 <== w1;
    AssertLessEq()(subjectIndex + 8 + P + projectLength + 124, headerLength);
}
