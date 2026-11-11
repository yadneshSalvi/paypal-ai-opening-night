import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductionConsole, type ViewProps } from "../src/components/production-console";
import { BoxOfficeView, EvidenceView, WrapView } from "../src/components/operations-views";
import { ExecutionView } from "../src/components/execution-view";
import { PlanView } from "../src/components/planning-views";
import { controlledCommercialInputs, crewPublished, crewTrust } from "./crew-fixtures";
import { allReadiness } from "../src/domain/readiness";
import { crewProductionOverview } from "../src/server/crew/projection";
import { projectExecutionMilestones } from "../src/domain/milestones";

function props(controlledQa: boolean): ViewProps {
  const { show, actor } = crewPublished(); controlledCommercialInputs(show);
  const data = { show, currentActor: actor, serverAt: new Date().toISOString(), controlledQa, readiness: allReadiness(show, crewTrust.verify), crew: crewProductionOverview(show) };
  return { data, onData: () => undefined, run: async () => null, busy: null, licenseKey: "" };
}
test("controlled crew rehearsal labels its show card and context bar as fixture inputs", () => {
  const fixture = props(true), html = renderToStaticMarkup(<ProductionConsole initial={fixture.data} view="show" licenseKey="" />);
  assert.match(html, /Controlled gross captures/); assert.match(html, /CONTROLLED COMMERCIAL INPUTS/); assert.match(html, /fixture captures/);
  assert.doesNotMatch(html, /actual captures|VERIFIED COMMERCIAL EXPOSURE|Verified gross captured/);
  const actual = renderToStaticMarkup(<ProductionConsole initial={props(false).data} view="show" licenseKey="" />);
  assert.match(actual, /VERIFIED COMMERCIAL EXPOSURE/); assert.match(actual, /actual captures/);
});
test("fixture money views identify seeded records and expose no payment review controls", () => {
  const value = props(true);
  const box = renderToStaticMarkup(<BoxOfficeView {...value} />);
  assert.match(box, /CONTROLLED GROSS CAPTURES/); assert.match(box, /fixture refund input/);
  assert.doesNotMatch(box, /actual captures|verified refunded|Review exact \$15 remedy|Individual ticket desk/);
  const wrap = renderToStaticMarkup(<WrapView {...value} />);
  assert.match(wrap, /CONTROLLED ACCOUNT/); assert.match(wrap, /Opening the production account/); assert.doesNotMatch(wrap, /VERIFIED CREW PAYOUTS|Review.*hold release/);
  const evidence = renderToStaticMarkup(<EvidenceView {...value} />);
  assert.match(evidence, /PROVIDERS DISABLED/); assert.match(evidence, /controlled financial inputs/); assert.doesNotMatch(evidence, /ACTUAL RECEIPTS|verified completed provider receipts are recorded/);
  const execution = renderToStaticMarkup(<ExecutionView {...value} />);
  assert.match(execution, /CONTROLLED FEE/); assert.match(execution, /Authorization is a controlled fixture input/); assert.match(execution, /fee capture is a controlled fixture input/);
  assert.doesNotMatch(execution, /Review \$780 authorization|fee capture is currently verified/);
  value.data.show = projectExecutionMilestones(value.data.show, crewTrust.verify);
  const plan = renderToStaticMarkup(<PlanView {...value} />);
  assert.match(plan, /FIXTURE AUTHORIZATION/); assert.match(plan, /FIXTURE CAPTURE/); assert.match(plan, /Controlled financial input; no provider qualification/);
  assert.doesNotMatch(plan, /Verified PayPal sandbox receipt/);
});
