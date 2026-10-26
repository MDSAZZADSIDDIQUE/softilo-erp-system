import { d, sum, toFixed, type DecInput } from "@softilo/domain";
import { COST_CATEGORIES, type CostCategory } from "./cis.js";

export interface JobCostInput {
  contractSum: DecInput;
  /** Approved variations only. */
  variations: DecInput[];
  budget: { category: CostCategory; amount: DecInput }[];
  costs: { category: CostCategory; amount: DecInput }[];
  /** Gross value applied for to date (latest application, before retention). */
  valuedToDate: DecInput;
}

export interface CategoryLine {
  category: CostCategory;
  budget: string;
  actual: string;
  /** Budget − actual: negative means over budget. */
  remaining: string;
  /** Actual as a percentage of budget, to one decimal place; null with no budget. */
  usedPercent: string | null;
}

export interface JobCostSummary {
  contractValue: string;
  budgetTotal: string;
  costToDate: string;
  valuedToDate: string;
  /** Value of work valued to date less cost to date. */
  marginToDate: string;
  /** Contract value less total budget: the margin if the job comes in on budget. */
  budgetedMargin: string;
  categories: CategoryLine[];
}

/** Budget against actual cost by category, and margin, for one project. */
export function jobCostSummary(i: JobCostInput): JobCostSummary {
  const contractValue = d(i.contractSum).plus(sum(i.variations));
  const categories = COST_CATEGORIES.map((category) => {
    const budget = sum(i.budget.filter((b) => b.category === category).map((b) => b.amount));
    const actual = sum(i.costs.filter((c) => c.category === category).map((c) => c.amount));
    return {
      category,
      budget: toFixed(budget),
      actual: toFixed(actual),
      remaining: toFixed(budget.minus(actual)),
      usedPercent: budget.isZero() ? null : actual.dividedBy(budget).times(100).toFixed(1),
    };
  });
  const budgetTotal = sum(categories.map((c) => c.budget));
  const costToDate = sum(categories.map((c) => c.actual));
  return {
    contractValue: toFixed(contractValue),
    budgetTotal: toFixed(budgetTotal),
    costToDate: toFixed(costToDate),
    valuedToDate: toFixed(i.valuedToDate),
    marginToDate: toFixed(d(i.valuedToDate).minus(costToDate)),
    budgetedMargin: toFixed(contractValue.minus(budgetTotal)),
    categories,
  };
}
