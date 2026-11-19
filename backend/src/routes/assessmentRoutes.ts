import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { allow, requireAuth, JwtUser } from "../auth";
import { audit } from "../audit";
import { recommendedAmount, repaymentCapacity } from "../assessmentMath";

export const assessmentRoutes = Router();

const RATINGS = ["strong", "average", "weak"];
const OWNERSHIP = ["owned", "rented", "other"];

type SubjectType = "client" | "group";

function parseRef(type: string, id: string): { type: SubjectType; id: number } | null {
  const n = Number(id);
  if ((type !== "client" && type !== "group") || !Number.isInteger(n)) return null;
  return { type, id: n };
}

// Returns the applicant's name when it belongs to this officer and is ready for assessment.
async function subjectName(type: SubjectType, id: number, officerId: number): Promise<string | null> {
  const { rows } =
    type === "client"
      ? await pool.query(
          "SELECT full_name AS name FROM clients WHERE id = $1 AND officer_id = $2 AND application_status = 'submitted'",
          [id, officerId]
        )
      : await pool.query(
          "SELECT name FROM loan_groups WHERE id = $1 AND officer_id = $2 AND status = 'assessment'",
          [id, officerId]
        );
  return rows[0]?.name ?? null;
}

const ratingOrNull = (v: unknown): string | null | "bad" => {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && RATINGS.includes(v) ? v : "bad";
};

const moneyOrNull = (v: unknown): number | null | "bad" => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 999_999_999_999 ? n : "bad";
};

function parsePayload(body: any, type: SubjectType) {
  const characterRating = ratingOrNull(body?.characterRating);
  const attitudeRating = ratingOrNull(body?.attitudeRating);
  const cohesionRating = ratingOrNull(body?.cohesionRating);
  const monthlySales = moneyOrNull(body?.monthlySales);
  const workingCapital = moneyOrNull(body?.workingCapital);
  const monthlyCashFlow = moneyOrNull(body?.monthlyCashFlow);
  const existingObligations = moneyOrNull(body?.existingObligations);
  const ownership = body?.premisesOwnership ? String(body.premisesOwnership) : null;
  const note = (v: unknown) => String(v ?? "").trim().slice(0, 1000);
  const submit = body?.submit === true;

  if ([characterRating, attitudeRating, cohesionRating].includes("bad")) {
    return { error: "Choose Strong, Average or Weak for each rating." as const };
  }
  if ([monthlySales, workingCapital, monthlyCashFlow, existingObligations].includes("bad")) {
    return { error: "Amounts must be whole numbers of zero or more." as const };
  }
  if (ownership !== null && !OWNERSHIP.includes(ownership)) {
    return { error: "Choose how the premises are held." as const };
  }

  if (submit) {
    const who = type === "group" ? "group" : "client";
    if (characterRating === null) return { error: `Rate the ${who}'s character on the Qualitative tab.` as const };
    if (attitudeRating === null) return { error: `Rate the ${who}'s repayment attitude on the Qualitative tab.` as const };
    if (type === "group" && cohesionRating === null) {
      return { error: "Rate the group's cohesion on the Qualitative tab." as const };
    }
    if (monthlySales === null) return { error: "Enter the monthly sales on the Quantitative tab." as const };
    if (monthlyCashFlow === null) return { error: "Enter the monthly cash flow on the Quantitative tab." as const };
  }

  return {
    value: {
      submit,
      characterRating: characterRating as string | null,
      characterNote: note(body?.characterNote),
      attitudeRating: attitudeRating as string | null,
      attitudeNote: note(body?.attitudeNote),
      cohesionRating: type === "group" ? (cohesionRating as string | null) : null,
      cohesionNote: type === "group" ? note(body?.cohesionNote) : "",
      monthlySales: monthlySales as number | null,
      workingCapital: workingCapital as number | null,
      monthlyCashFlow: monthlyCashFlow as number | null,
      existingObligations: existingObligations as number | null,
      premisesVisited: body?.premisesVisited === true,
      premisesOwnership: ownership,
      premisesNotes: note(body?.premisesNotes),
    },
  };
}

assessmentRoutes.use(allow("assessment.do"));

// Applicants this officer can assess
assessmentRoutes.get("/subjects", async (_req, res) => {
  const user = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `SELECT 'client' AS type, c.id, c.full_name AS name,
              COALESCE(a.status, 'none') AS "assessmentStatus"
         FROM clients c
         LEFT JOIN assessments a ON a.subject_type = 'client' AND a.subject_id = c.id
        WHERE c.officer_id = $1 AND c.application_status = 'submitted'
       UNION ALL
       SELECT 'group', g.id, g.name, COALESCE(a.status, 'none')
         FROM loan_groups g
         LEFT JOIN assessments a ON a.subject_type = 'group' AND a.subject_id = g.id
        WHERE g.officer_id = $1 AND g.status = 'assessment'
       ORDER BY name`,
      [user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the applicants. Try again." });
  }
});

// One assessment, or null when none was started
assessmentRoutes.get("/:type/:id", async (req, res) => {
  const ref = parseRef(req.params.type, req.params.id);
  if (!ref) return res.status(400).json({ message: "Invalid request." });
  const user = res.locals.user as JwtUser;
  try {
    if (!(await subjectName(ref.type, ref.id, user.id))) {
      return res.status(404).json({ message: "Applicant not found, or not ready for assessment." });
    }
    const { rows } = await pool.query(
      `SELECT status,
              character_rating AS "characterRating", character_note AS "characterNote",
              attitude_rating AS "attitudeRating", attitude_note AS "attitudeNote",
              cohesion_rating AS "cohesionRating", cohesion_note AS "cohesionNote",
              monthly_sales::float8 AS "monthlySales", working_capital::float8 AS "workingCapital",
              monthly_cash_flow::float8 AS "monthlyCashFlow",
              existing_obligations::float8 AS "existingObligations",
              repayment_capacity::float8 AS "repaymentCapacity",
              recommended_amount::float8 AS "recommendedAmount",
              premises_visited AS "premisesVisited", premises_ownership AS "premisesOwnership",
              premises_notes AS "premisesNotes"
         FROM assessments WHERE subject_type = $1 AND subject_id = $2`,
      [ref.type, ref.id]
    );
    res.json({ assessment: rows[0] ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the assessment. Try again." });
  }
});

// Save a draft, or submit. The figures are always calculated here.
assessmentRoutes.put("/:type/:id", async (req, res) => {
  const ref = parseRef(req.params.type, req.params.id);
  if (!ref) return res.status(400).json({ message: "Invalid request." });
  const parsed = parsePayload(req.body, ref.type);
  if ("error" in parsed) return res.status(400).json({ message: parsed.error });
  const v = parsed.value;
  const user = res.locals.user as JwtUser;

  try {
    const name = await subjectName(ref.type, ref.id, user.id);
    if (!name) return res.status(404).json({ message: "Applicant not found, or not ready for assessment." });

    const capacity =
      v.monthlyCashFlow === null ? null : repaymentCapacity(v.monthlyCashFlow, v.existingObligations ?? 0);
    const recommended =
      capacity === null || v.monthlySales === null ? null : recommendedAmount(v.monthlySales, capacity);
    const status = v.submit ? "submitted" : "draft";

    const { rows } = await pool.query(
      `INSERT INTO assessments
         (subject_type, subject_id, officer_id, status,
          character_rating, character_note, attitude_rating, attitude_note,
          cohesion_rating, cohesion_note,
          monthly_sales, working_capital, monthly_cash_flow, existing_obligations,
          repayment_capacity, recommended_amount,
          premises_visited, premises_ownership, premises_notes, submitted_at)
       VALUES ($1, $2, $3, $4::text, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               CASE WHEN $4::text = 'submitted' THEN now() ELSE NULL END)
       ON CONFLICT (subject_type, subject_id) DO UPDATE SET
          status = EXCLUDED.status,
          character_rating = EXCLUDED.character_rating, character_note = EXCLUDED.character_note,
          attitude_rating = EXCLUDED.attitude_rating, attitude_note = EXCLUDED.attitude_note,
          cohesion_rating = EXCLUDED.cohesion_rating, cohesion_note = EXCLUDED.cohesion_note,
          monthly_sales = EXCLUDED.monthly_sales, working_capital = EXCLUDED.working_capital,
          monthly_cash_flow = EXCLUDED.monthly_cash_flow,
          existing_obligations = EXCLUDED.existing_obligations,
          repayment_capacity = EXCLUDED.repayment_capacity,
          recommended_amount = EXCLUDED.recommended_amount,
          premises_visited = EXCLUDED.premises_visited,
          premises_ownership = EXCLUDED.premises_ownership,
          premises_notes = EXCLUDED.premises_notes,
          updated_at = now(),
          submitted_at = EXCLUDED.submitted_at
        WHERE assessments.status = 'draft'
       RETURNING status, repayment_capacity::float8 AS "repaymentCapacity",
                 recommended_amount::float8 AS "recommendedAmount"`,
      [
        ref.type, ref.id, user.id, status,
        v.characterRating, v.characterNote, v.attitudeRating, v.attitudeNote,
        v.cohesionRating, v.cohesionNote,
        v.monthlySales, v.workingCapital, v.monthlyCashFlow, v.existingObligations,
        capacity, recommended,
        v.premisesVisited, v.premisesOwnership, v.premisesNotes,
      ]
    );
    if (!rows[0]) {
      return res.status(409).json({ message: "This assessment was already submitted and can no longer be changed." });
    }
    await audit(user.username, v.submit ? "Assessment submitted" : "Assessment draft saved", name);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the assessment. Try again." });
  }
});
