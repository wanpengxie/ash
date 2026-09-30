import test from "node:test";
import { WORD_CONTRACTS } from "../../../sdk/src/words";

// These are explicit implementation gates. The schemas are exercised now by
// packages/sdk/test/v2-contract.test.ts; routing is not part of this card.
for (const contract of WORD_CONTRACTS) {
  test.skip(`${contract.member}/${contract.word} routes with its declared schema`, () => {});
}
