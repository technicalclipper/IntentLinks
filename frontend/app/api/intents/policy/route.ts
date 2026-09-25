import { policyHash as hashPolicy, type Policy } from "@/lib/policy";
import { newCapsuleSalt, recipientHash } from "@/lib/zklogin/server";

/**
 * Hash the policy and mint the recipient commitment.
 *
 * Both happen server-side because the salt must stay secret — a bare hash of
 * an email on a public chain is trivially brute-forced, and the salt is what
 * makes the commitment meaningless to an observer.
 */
export async function POST(request: Request) {
  try {
    const { policy, recipientEmail } = (await request.json()) as {
      policy?: Policy;
      recipientEmail?: string | null;
    };
    if (!policy) return Response.json({ error: "policy is required" }, { status: 400 });

    const salt = newCapsuleSalt();

    return Response.json({
      policyHash: hashPolicy(policy),
      salt,
      boundRecipient: recipientEmail ? recipientHash(recipientEmail, salt) : null,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
