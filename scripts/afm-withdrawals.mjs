// Only a complete AFM crawl can establish that a listed variant has no price.
// Keep the historical price, but append a withdrawal against the same listing.
export function afmWithdrawalObservations(previousOffers, unpriced, fetchedAt = new Date().toISOString()) {
  const prior = new Map(previousOffers.filter(offer => offer.retailer === 'AFM')
    .map(offer => [offer.externalId, offer]));
  const withdrawals = [];
  for (const item of unpriced) {
    const old = prior.get(item.externalId || `afm:${item.productId}:${item.editionId}`);
    if (!old || old.withdrawn) continue;
    const withdrawal = { ...old, url: item.url, price: null, priceMinor: null,
      fetchedAt, observedAt: fetchedAt, status: 'withdrawn', validationStatus: 'withdrawn', rejected: true,
      qualityWarnings: ['AFM больше не публикует цену этого варианта'],
      raw: item, evidence: { method: 'afm-unpriced-variant-v1', productId: item.productId, editionId: item.editionId },
      visibility: 'public', dataKind: 'live' };
    delete withdrawal.observationId;
    delete withdrawal.latestAttempt;
    withdrawals.push(withdrawal);
  }
  return withdrawals;
}
