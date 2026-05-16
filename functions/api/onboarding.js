const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
};

const FIELD_LIMITS = {
	role: 80,
	name: 160,
	website: 300,
	email: 254,
	phone: 80,
	project: 3000,
	titles: 20,
	timeline: 80,
	notes: 3000,
	topic: 120,
	_subject: 160,
	needs: 80,
};

const VALID_ROLES = new Set([
	"Author",
	"Publisher",
	"Library",
	"University / Research",
	"Government organization",
	"Public organization",
	"Other business entity",
]);

const VALID_NEEDS = new Set([
	"Web publishing",
	"Sales",
	"Fan clubs",
	"EPUB output",
	"Migration / catalog import",
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequest(context) {
	if (context.request.method !== "POST") {
		return json({ ok: false, error: "Method not allowed" }, 405, {
			Allow: "POST",
		});
	}
	return onRequestPost(context);
}

export async function onRequestPost({ request, env }) {
	try {
		let formData;
		try {
			formData = await request.formData();
		} catch (_error) {
			return json({ ok: false, error: "Invalid form submission." }, 400);
		}

		const gotcha = clean(formData.get("_gotcha"), FIELD_LIMITS._gotcha || 200);
		if (gotcha) {
			return json({ ok: true });
		}

		const turnstileResult = await verifyTurnstile({ request, env, formData });
		if (!turnstileResult.ok) {
			return json({ ok: false, error: turnstileResult.error }, 400);
		}

		const validation = validateSubmission(formData);
		if (!validation.ok) {
			return json({ ok: false, error: validation.error }, 400);
		}

		const config = getConfig(env, request);
		if (!config.ok) {
			return json({ ok: false, error: config.error }, 500);
		}

		try {
			const internalEmail = buildInternalEmail(validation.submission, config);
			const autoReplyEmail = buildAutoReplyEmail(validation.submission, config);
			await sendPingramEmail(config, internalEmail);
			await sendPingramEmail(config, autoReplyEmail);
		} catch (error) {
			console.error(`Onboarding email delivery failed: ${error?.message || String(error)}`);
			return json({ ok: false, error: "Email provider failed." }, 502);
		}

		return json({ ok: true });
	} catch (error) {
		console.error(`Onboarding function failed: ${error?.message || String(error)}`);
		return json({ ok: false, error: "We could not submit your request. Please try again." }, 500);
	}
}

function json(payload, status = 200, headers = {}) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			...JSON_HEADERS,
			...headers,
		},
	});
}

function clean(value, limit) {
	return String(value || "").trim().slice(0, limit);
}

function validateSubmission(formData) {
	const errors = [];
	const field = (name, label) => {
		const value = String(formData.get(name) || "").trim();
		if (value.length > FIELD_LIMITS[name]) errors.push(`${label} is too long.`);
		return value;
	};

	const submission = {
		role: field("role", "Role"),
		name: field("name", "Organization or author name"),
		website: field("website", "Website"),
		email: field("email", "Email").toLowerCase(),
		phone: field("phone", "Phone"),
		project: field("project", "Project"),
		titles: field("titles", "Title estimate"),
		timeline: field("timeline", "Timeline"),
		notes: field("notes", "Notes"),
		topic: field("topic", "Topic"),
		subject: field("_subject", "Subject") || "ReaderPub Onboarding Request",
		needs: formData
			.getAll("needs")
			.map((value) => String(value || "").trim())
			.filter(Boolean)
			.map((value) => {
				if (value.length > FIELD_LIMITS.needs) errors.push("Selected needs are too long.");
				return value;
			}),
	};

	if (errors.length) return invalid(errors[0]);
	if (!submission.role) return invalid("Please select who you are.");
	if (!VALID_ROLES.has(submission.role)) return invalid("Please select a valid role.");
	if (!submission.name) return invalid("Please enter your organization or author name.");
	if (!submission.email) return invalid("Please enter your email.");
	if (!EMAIL_PATTERN.test(submission.email)) return invalid("Please enter a valid email.");
	if (!submission.project) return invalid("Please describe what you want to publish or launch.");
	if (submission.needs.some((need) => !VALID_NEEDS.has(need))) {
		return invalid("Please select valid onboarding needs.");
	}

	if (submission.titles && !/^\d{1,12}$/.test(submission.titles)) {
		return invalid("Please enter a valid title estimate.");
	}

	return { ok: true, submission };
}

function invalid(error) {
	return { ok: false, error };
}

function getConfig(env, request) {
	const apiKey = clean(env.PINGRAM_API_KEY, 500);
	const clientId = clean(env.PINGRAM_CLIENT_ID, 200);
	const clientSecret = clean(env.PINGRAM_CLIENT_SECRET, 500);
	const senderName = clean(env.PINGRAM_SENDER_NAME, 120) || "ReaderPub";
	const senderEmail = clean(env.PINGRAM_SENDER_EMAIL, 254);
	const toEmail = clean(env.ONBOARDING_TO_EMAIL, 254);
	const replyToEmail = clean(env.ONBOARDING_REPLY_TO_EMAIL, 254) || toEmail || senderEmail;
	const siteName = clean(env.ONBOARDING_SITE_NAME, 120) || "ReaderPub";
	const baseUrl = clean(
		env.PINGRAM_API_BASE_URL || env.NOTIFICATIONAPI_BASE_URL || "https://api.notificationapi.com",
		300
	).replace(/\/+$/, "");
	const siteUrl = clean(env.ONBOARDING_SITE_URL, 300) || new URL(request.url).origin;
	const logoUrl = clean(env.ONBOARDING_LOGO_URL, 500) || `${siteUrl.replace(/\/+$/, "")}/images/small-logo.jpg`;

	if (!apiKey && !(clientId && clientSecret)) {
		return { ok: false, error: "Email provider configuration is incomplete." };
	}
	if (!senderEmail || !toEmail) {
		return { ok: false, error: "Onboarding email configuration is incomplete." };
	}
	if (!EMAIL_PATTERN.test(senderEmail) || !EMAIL_PATTERN.test(toEmail) || !EMAIL_PATTERN.test(replyToEmail)) {
		return { ok: false, error: "Onboarding email configuration is invalid." };
	}

	return {
		ok: true,
		apiKey,
		clientId,
		clientSecret,
		baseUrl,
		senderName,
		senderEmail,
		toEmail,
		replyToEmail,
		siteName,
		logoUrl,
	};
}

async function verifyTurnstile({ request, env, formData }) {
	const secret = clean(env.TURNSTILE_SECRET_KEY, 500);
	if (!secret) return { ok: true };

	const token = clean(formData.get("cf-turnstile-response"), 2000);
	if (!token) return { ok: false, error: "Verification failed. Please try again." };

	const body = new FormData();
	body.set("secret", secret);
	body.set("response", token);
	const ip = request.headers.get("CF-Connecting-IP");
	if (ip) body.set("remoteip", ip);

	try {
		const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			body,
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok || !payload?.success) {
			return { ok: false, error: "Verification failed. Please try again." };
		}
		return { ok: true };
	} catch (error) {
		console.error("Turnstile verification failed", error);
		return { ok: false, error: "Verification failed. Please try again." };
	}
}

function buildInternalEmail(submission, config) {
	const subject = `${config.siteName} onboarding request: ${submission.name}`;
	const lines = [
		`Role: ${submission.role}`,
		`Name: ${submission.name}`,
		`Email: ${submission.email}`,
		`Website: ${submission.website || "-"}`,
		`Phone: ${submission.phone || "-"}`,
		`Titles: ${submission.titles || "-"}`,
		`Timeline: ${submission.timeline || "-"}`,
		`Topic: ${submission.topic || "-"}`,
		`Needs: ${submission.needs.length ? submission.needs.join(", ") : "-"}`,
		"",
		"Project:",
		submission.project,
		"",
		"Notes:",
		submission.notes || "-",
	];

	return {
		to: config.toEmail,
		toId: "readerpub-onboarding",
		subject,
		text: lines.join("\n"),
		html: `<h2>${escapeHtml(subject)}</h2>${lines
			.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
			.join("")}`,
	};
}

function buildAutoReplyEmail(submission, config) {
	const subject = `We received your ${config.siteName} onboarding request`;
	const logoHtml = config.logoUrl
		? `<br><img src="${escapeHtml(config.logoUrl)}" alt="${escapeHtml(
				config.siteName
		  )}" width="100" style="display:block;margin-top:12px;max-width:100px;height:auto;border:0;">`
		: "";
	const text = [
		`Hello ${submission.name},`,
		"",
		`Thank you for contacting ${config.siteName}. We received your onboarding request and will reply with an onboarding plan and proposed timeline soon.`,
		"",
		"Best regards,",
		"",
		config.siteName,
	].join("\n");

	return {
		to: submission.email,
		toId: submission.email,
		subject,
		text,
		html: `<p>Hello ${escapeHtml(submission.name)},</p><p>Thank you for contacting ${escapeHtml(
			config.siteName
		)}. We received your onboarding request and will reply with an onboarding plan and proposed timeline soon.</p><p>Best regards,<br>${escapeHtml(
			config.siteName
		)}${logoHtml}</p>`,
	};
}

async function sendPingramEmail(config, message) {
	const payload = {
		type: "readerpub_onboarding",
		to: {
			id: message.toId || message.to,
			email: message.to,
		},
		email: {
			subject: message.subject,
			html: message.html,
			previewText: message.text.slice(0, 200),
			senderName: config.senderName,
			senderEmail: config.senderEmail,
		},
		options: {
			email: {
				fromAddress: config.senderEmail,
				fromName: config.senderName,
				replyToAddresses: [config.replyToEmail],
			},
		},
	};

	let endpoint = `${config.baseUrl}/send`;
	const headers = {
		"content-type": "application/json",
	};

	if (config.apiKey) {
		headers.authorization = `Bearer ${config.apiKey}`;
		headers["x-api-key"] = config.apiKey;
	} else {
		endpoint = `${config.baseUrl}/${encodeURIComponent(config.clientId)}/sender`;
		headers.authorization = `Basic ${toBase64(`${config.clientId}:${config.clientSecret}`)}`;
	}

	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(detail || `Pingram request failed with HTTP ${response.status}`);
	}

	return response.json().catch(() => ({}));
}

function toBase64(value) {
	if (typeof btoa === "function") return btoa(value);
	throw new Error("Base64 encoding is unavailable in this runtime.");
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
