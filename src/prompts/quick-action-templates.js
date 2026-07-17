// src/prompts/quick-action-templates.js
//
// The flagship legal quick actions, expressed as prompt templates over page
// context. Consumed by src/sidepanel/sidepanel.js — the quick-action chip
// row and the '/' slash-command popover are built directly from
// QUICK_ACTIONS (+ SECONDARY for the "+more" expander). Each action's
// `prompt` is a function(ctx) => string that produces the literal user
// message sent to the model (wrapping of page content in
// <untrusted_page_content> happens separately in agent-loop.js /
// sidepanel.js via wrapUntrusted()/sanitize() from system-prompts.js — these
// templates only produce the human-readable instruction/question part).
//
// ctx shape passed to every prompt(ctx) function:
//   {
//     selection?: string   // user's current text selection on the page, if any
//     pageText?: string    // the page's extracted readable text (already
//                           // sanitized/wrapped by the caller if included
//                           // inline; templates that just need to reference
//                           // "the page" don't need to re-embed it — the
//                           // caller appends the wrapped page content as a
//                           // separate content block/turn)
//     userQuestion?: string // free-text the user typed alongside the action
//   }
//
// Per user-memory (feedback_no_hardcoding_ai_drafting): no prompt below
// hardcodes a paragraph count, bullet count, or word limit — structure is
// described qualitatively and length is left to the model's judgment.

function clauseTarget(ctx) {
  const sel = (ctx && ctx.selection) ? ctx.selection.trim() : '';
  if (sel) {
    return `the following selected passage:\n\n"""\n${sel}\n"""`;
  }
  const q = (ctx && ctx.userQuestion) ? ctx.userQuestion.trim() : '';
  if (q) {
    return `the clause the user is referring to: "${q}"`;
  }
  return 'the most relevant clause on the current page (use your judgment about what the user likely means; if it is genuinely ambiguous which clause, ask which one)';
}

// ---------------------------------------------------------------------------
// Primary flagship actions (shown as chips + slash commands).
// ---------------------------------------------------------------------------

export const QUICK_ACTIONS = [
  {
    id: 'explain',
    label: 'Explain this clause',
    slash: '/explain',
    needs: 'selection|page',
    prompt(ctx) {
      return [
        `Explain, in plain English, ${clauseTarget(ctx)}.`,
        `Define any legal or technical jargon it uses in ordinary language as you go, rather than leaving terms unexplained.`,
        `Explain what this clause practically means for each party involved (who benefits, who bears risk or burden, and how).`,
        `Stay jurisdiction-neutral — do not assume a particular country's law applies unless the page states one.`,
        `If the passage is ambiguous or could be read more than one way, say so and explain the readings rather than picking one silently.`,
      ].join(' ');
    },
  },
  {
    id: 'flag-risk',
    label: 'Flag risky terms',
    slash: '/flag-risk',
    needs: 'page',
    prompt() {
      return [
        `Scan the whole page and return a ranked list of risky or one-sided terms actually present in it.`,
        `For each item, start its line with the severity label — HIGH, MED, or LOW — then give: the term/clause, why it is risky (what it could cost the disadvantaged party or what leverage it removes from them), and where it appears on the page (a short quote or section reference so the user can find it).`,
        `Pay particular attention to (when present): auto-renewal / evergreen terms, unilateral amendment rights, broad or one-sided indemnification, limitation-of-liability carve-outs, arbitration clauses and class-action waivers, liquidated damages, restrictive assignment terms, and termination rights that favor one side.`,
        `Only report clauses that are actually present on the page — do not invent or assume a clause exists just because it is common in this type of document; if a commonly-risky clause is notably absent, you may mention that as a neutral observation, clearly distinguished from the risks you actually found.`,
        `Order the list from highest to lowest severity.`,
      ].join(' ');
    },
  },
  {
    id: 'dates',
    label: 'Key dates & obligations',
    slash: '/dates',
    needs: 'page',
    prompt() {
      return [
        `Extract every date, deadline, trigger event, and ongoing obligation stated on the page into a structured table with the columns: Party | Obligation | Deadline/Trigger | Condition.`,
        `"Party" is who the obligation falls on; "Obligation" is what they must do; "Deadline/Trigger" is the date or event that starts the clock or when it is due; "Condition" is any qualifier that changes whether/when it applies.`,
        `Make the table copyable as plain text (use a simple markdown table). Only include items actually stated in the page's text — do not infer dates or obligations that are not written there.`,
        `If the page has no dates or obligations at all, say so plainly instead of producing an empty or padded table.`,
      ].join(' ');
    },
  },
  {
    id: 'summary',
    label: 'Summarize judgment/statute',
    slash: '/summary',
    needs: 'page',
    prompt() {
      return [
        `Summarize the page in a structure appropriate to what kind of legal document it is.`,
        `If it is a court judgment or decision: cover the holding (the actual ruling/outcome), the reasoning the court gave for reaching it, the disposition (what happens next / what was ordered), and the key authorities or precedents it cites.`,
        `If it is a statute, regulation, or similar legislative text: cover its scope (what it applies to and who), its key provisions, and any important definitions it establishes.`,
        `If the page is some other kind of legal or legal-adjacent document, use your judgment to summarize the parts a reader would actually need — but always ground every point in text that is actually present on the page.`,
        `Note explicitly if you are unsure what type of document this is, rather than forcing it into the wrong structure.`,
      ].join(' ');
    },
  },
  {
    id: 'plain-english',
    label: 'What am I agreeing to?',
    slash: '/plain-english',
    needs: 'page',
    prompt() {
      return [
        `Explain, from the point of view of an ordinary person about to click "I agree" or sign, what they are actually agreeing to on this page.`,
        `Write it as a short list of plain-English bullet points covering the practical consequences that matter most to someone in that position — not a clause-by-clause legal breakdown.`,
        `Finish with a clear bottom-line verdict: whether the terms look broadly standard for this type of document, or how many clauses are unusual/one-sided enough that the person should pay attention before agreeing.`,
        `Be concrete and specific to what is actually on this page — avoid generic warnings that could apply to any contract.`,
      ].join(' ');
    },
  },
  {
    id: 'screenshot-ask',
    label: 'Screenshot & ask',
    slash: '/screenshot-ask',
    needs: 'screenshot',
    prompt(ctx) {
      const q = (ctx && ctx.userQuestion) ? ctx.userQuestion.trim() : '';
      const question = q || 'Describe what is shown and explain anything legally relevant about it (e.g. a chart, table, signature block, or scanned exhibit).';
      return [
        `Look at the attached screenshot of the current page and answer the following question about it: ${question}`,
        `Base your answer only on what is visibly shown in the image (and any accompanying page text provided) — do not assume content that isn't visible.`,
      ].join(' ');
    },
  },
];

// ---------------------------------------------------------------------------
// Secondary actions, surfaced behind the "+more" expander in the quick-
// action row / slash menu.
// ---------------------------------------------------------------------------

export const SECONDARY = [
  {
    id: 'draft-redline',
    label: 'Draft a redline',
    slash: '/draft-redline',
    needs: 'selection|page',
    prompt(ctx) {
      return [
        `Propose a redline (suggested edit) for ${clauseTarget(ctx)}.`,
        `Show the original wording, the proposed replacement wording, and a short explanation of why the change would make the clause fairer or clearer — note whether the change primarily benefits the party who would be signing/agreeing, and be explicit that this is a starting-point suggestion for negotiation, not a guarantee the other side will accept it.`,
        `Stay jurisdiction-neutral unless the page states a governing law.`,
      ].join(' ');
    },
  },
  {
    id: 'compare-tabs',
    label: 'Compare with the other tab',
    slash: '/compare-tabs',
    needs: 'page',
    prompt(ctx) {
      const q = (ctx && ctx.userQuestion) ? ctx.userQuestion.trim() : '';
      return [
        `Compare this page with the other open tab the user has referenced${q ? ` (their specific question: "${q}")` : ''}.`,
        `Identify the material differences between the two documents/drafts — clauses that appear in one but not the other, and clauses that appear in both but with different terms — and explain what each difference means in practice.`,
        `If the two documents are not comparable (different subject matter entirely), say so rather than forcing a comparison.`,
      ].join(' ');
    },
  },
  {
    id: 'define-term',
    label: 'Define this term',
    slash: '/define-term',
    needs: 'selection|page',
    prompt(ctx) {
      const sel = (ctx && ctx.selection) ? ctx.selection.trim() : '';
      const q = (ctx && ctx.userQuestion) ? ctx.userQuestion.trim() : '';
      const term = sel || q || 'the term the user selected or asked about';
      return [
        `Define "${term}" as it is used on this page, in plain English.`,
        `If the page itself defines the term (e.g. in a definitions section), quote or closely paraphrase that definition first and note that it is the document's own definition, which can differ from the general legal meaning; then add the general meaning as a comparison if useful.`,
        `Keep it jurisdiction-neutral unless the page specifies a governing law.`,
      ].join(' ');
    },
  },
  {
    id: 'citation-format',
    label: 'Check/format this citation',
    slash: '/citation-format',
    needs: 'selection|page',
    prompt(ctx) {
      const sel = (ctx && ctx.selection) ? ctx.selection.trim() : '';
      const target = sel ? `the following citation:\n\n"""\n${sel}\n"""` : 'the citation(s) referenced on this page';
      return [
        `Check ${target} for internal consistency and completeness (e.g. case name, reporter/volume/page or neutral citation, year, court, section/article numbers as applicable), and note anything that looks malformed, incomplete, or inconsistent within the citation itself.`,
        `Do not claim to have verified the citation against an external database unless you actually have access to one — if you cannot verify it resolves to a real authority, say that clearly instead of implying verification.`,
        `If asked, reformat it consistently, and state which citation convention you used.`,
      ].join(' ');
    },
  },
];
