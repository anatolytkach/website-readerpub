const WEBSITE_ORIGIN = "https://readerpub-website.pages.dev";

export default {
	async fetch(request) {
		const upstreamUrl = new URL(request.url);
		const origin = new URL(WEBSITE_ORIGIN);
		upstreamUrl.protocol = origin.protocol;
		upstreamUrl.hostname = origin.hostname;
		upstreamUrl.port = "";

		const upstreamRequest = new Request(upstreamUrl, request);
		const response = await fetch(upstreamRequest);
		const headers = new Headers(response.headers);
		headers.set("x-readerpub-website-router", "1");

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	},
};
