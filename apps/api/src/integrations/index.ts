import { demoAi, geminiAi } from "./ai.js";
import { demoBankFeed, liveBankFeed } from "./bank-feed.js";
import { modeOf, type Service } from "./config.js";
import { demoHmrc, liveHmrc } from "./hmrc.js";
import { demoCompaniesHouse, demoEmail, demoFx, demoVatCheck, liveCompaniesHouse, liveEmail, liveFx, liveVatCheck } from "./services.js";
import type { AiProvider, BankFeedProvider, CompaniesHouseProvider, EmailProvider, FxProvider, HmrcVatProvider, ProviderInfo, VatCheckProvider } from "./types.js";

export * from "./types.js";

export interface Providers {
  hmrc: HmrcVatProvider;
  bankFeed: BankFeedProvider;
  companiesHouse: CompaniesHouseProvider;
  vatCheck: VatCheckProvider;
  email: EmailProvider;
  fx: FxProvider;
  ai: AiProvider;
}

/** Build the provider set from the environment. Tests pass their own env (or their own providers to buildServer). */
export function createProviders(env: NodeJS.ProcessEnv = process.env): Providers {
  const live = (s: Service) => modeOf(s, env) === "live";
  return {
    hmrc: live("hmrc") ? liveHmrc(env) : demoHmrc(),
    bankFeed: live("bank_feed") ? liveBankFeed(env) : demoBankFeed(),
    companiesHouse: live("companies_house") ? liveCompaniesHouse(env) : demoCompaniesHouse(),
    vatCheck: live("vat_check") ? liveVatCheck(env) : demoVatCheck(),
    email: live("email") ? liveEmail(env) : demoEmail(),
    fx: live("fx") ? liveFx() : demoFx(),
    ai: live("ai") ? geminiAi(env) : demoAi(),
  };
}

export function describeProviders(p: Providers): Record<keyof Providers, ProviderInfo> {
  return {
    hmrc: p.hmrc.info(), bankFeed: p.bankFeed.info(), companiesHouse: p.companiesHouse.info(), vatCheck: p.vatCheck.info(),
    email: p.email.info(), fx: p.fx.info(), ai: p.ai.info(),
  };
}

/** Every provider that is live but missing credentials, as one message per service (logged at start-up). */
export function configurationProblems(p: Providers): string[] {
  return Object.entries(describeProviders(p))
    .filter(([, i]) => i.mode === "live" && !i.ready)
    .map(([k, i]) => `${k} is set to live but ${i.missing?.join(", ")} ${i.missing?.length === 1 ? "is" : "are"} not set`);
}
