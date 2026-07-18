using System.Text.Json;

using Narya.Application.Actions;

namespace Narya.Api.Controllers;

/// <summary>
/// Binds a manual-run request body into a <see cref="TemplateContext"/> — shared by
/// <see cref="ActionsController.Run"/> (<c>POST /api/actions/{id}/run</c>) and
/// <see cref="AutomationTriggersController.Run"/> (<c>POST /api/automation/triggers/{id}/run</c>,
/// Phase 4 Task 6), which both bypass their respective dispatcher's cooldown/dedup/gating and need
/// the identical body shape. A port of legacy's <c>normalizeRunContext</c>.
/// </summary>
internal static class RunContextBinder
{
  private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

  /// <summary>
  /// The request body may either wrap the context under a <c>"context"</c> property
  /// (<c>{ "context": { "actor": "..." } }</c>) or BE the context directly
  /// (<c>{ "actor": "..." }</c>) — both shapes are accepted so a caller posting a bare invocation
  /// payload does not need to know about the wrapper. An absent/non-object body (including no body
  /// at all) normalizes to an empty <see cref="TemplateContext"/>.
  /// </summary>
  public static TemplateContext Normalize(JsonElement? body)
  {
    if (body is not { ValueKind: JsonValueKind.Object } value)
    {
      return new TemplateContext();
    }

    var source = value.TryGetProperty("context", out var contextProperty) && contextProperty.ValueKind == JsonValueKind.Object
      ? contextProperty
      : value;

    return JsonSerializer.Deserialize<TemplateContext>(source.GetRawText(), Options) ?? new TemplateContext();
  }
}
