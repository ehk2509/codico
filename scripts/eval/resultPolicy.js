function evaluateHoldoutResult(record) {
  const metrics = record.metrics || null;
  const maxTotalTokens = Number(record.maxTotalTokens || 0);
  const withinTokenBudget = Boolean(
    metrics &&
    (
      maxTotalTokens <= 0 ||
      (!metrics.budgetExceeded && metrics.totalTokens <= maxTotalTokens)
    )
  );

  return {
    withinTokenBudget,
    success: Boolean(
      record.setupOk &&
      record.agentOk &&
      record.verifierOk &&
      withinTokenBudget
    ),
  };
}

module.exports = { evaluateHoldoutResult };
