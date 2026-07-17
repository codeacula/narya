namespace Narya.Twitch.Tests.Oauth;

/// <summary>
/// A minimal fake <see cref="HttpMessageHandler"/> that records every request it sees
/// (including its form-encoded body, read eagerly before the request is handed off) and
/// answers with a caller-supplied canned response — the seam <c>TwitchOAuthClientTests</c>
/// needs to assert on exact POST bodies with zero real network calls.
/// </summary>
public sealed class FakeHttpMessageHandler(Func<HttpRequestMessage, string, HttpResponseMessage> respond) : HttpMessageHandler
{
  public List<RecordedRequest> Requests { get; } = [];

  protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
  {
    var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
    Requests.Add(new RecordedRequest(request.RequestUri, body, ParseForm(body)));
    return respond(request, body);
  }

  private static Dictionary<string, string> ParseForm(string body) =>
    string.IsNullOrEmpty(body)
      ? []
      : body
        .Split('&', StringSplitOptions.RemoveEmptyEntries)
        .Select(pair => pair.Split('=', 2))
        .ToDictionary(
          parts => Uri.UnescapeDataString(parts[0].Replace('+', ' ')),
          parts => parts.Length > 1 ? Uri.UnescapeDataString(parts[1].Replace('+', ' ')) : "");
}

public sealed record RecordedRequest(Uri? RequestUri, string RawBody, Dictionary<string, string> Form);
