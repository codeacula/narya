using Microsoft.AspNetCore.Mvc;

using Narya.Core.Media;

namespace Narya.Api.Controllers;

/// <summary>
/// <c>/api/media-assets</c> (CRUD) and <c>/api/media/discovered</c> — a port of legacy's
/// <c>registerMediaAssetRoutes</c> (<c>legacy/src/server/mediaAssets.ts</c>). Deliberately
/// absent from <see cref="Narya.Api.Auth.DashboardTokenMiddleware.OverlayPaths"/> — the catalog
/// (including the raw filesystem scan behind <c>/api/media/discovered</c>) is operator-only
/// configuration, not something an overlay browser source needs to read.
///
/// <para>
/// Talks directly to <see cref="IMediaAssetStore"/>/<see cref="IMediaFileCatalog"/> rather than
/// routing through MediatR — <see cref="AutomodController"/> is the precedent for a controller
/// orchestrating a store directly when the route needs to load-then-branch on 404/409 the way
/// <see cref="Update"/>/<see cref="Delete"/> do here (an unknown id 404s before a validation
/// failure would ever 400, and a delete blocked by a live reference 409s), rather than forcing
/// that branching through a single <c>Result&lt;T&gt;</c> shape.
/// </para>
/// </summary>
[ApiController]
[Route("api")]
public sealed class MediaAssetsController(IMediaAssetStore store, IMediaFileCatalog catalog) : ControllerBase
{
  [HttpGet("media-assets")]
  public async Task<IActionResult> GetAll(CancellationToken cancellationToken)
  {
    var assets = await store.GetAllAsync(cancellationToken).ConfigureAwait(false);
    return Ok(new MediaAssetsResponse(assets));
  }

  [HttpPost("media-assets")]
  public async Task<IActionResult> Create([FromBody] MediaAssetPatch? body, CancellationToken cancellationToken)
  {
    var result = await store.CreateAsync(body ?? new MediaAssetPatch(), cancellationToken).ConfigureAwait(false);
    return result.IsFailed
      ? BadRequest(new { errors = result.Errors.Select(e => e.Message) })
      : StatusCode(StatusCodes.Status201Created, result.Value);
  }

  [HttpPut("media-assets/{id:guid}")]
  public async Task<IActionResult> Update(Guid id, [FromBody] MediaAssetPatch? body, CancellationToken cancellationToken)
  {
    var result = await store.UpdateAsync(id, body ?? new MediaAssetPatch(), cancellationToken).ConfigureAwait(false);
    if (result is null)
    {
      return NotFound(new { error = "Unknown media asset." });
    }

    return result.IsFailed
      ? BadRequest(new { errors = result.Errors.Select(e => e.Message) })
      : Ok(result.Value);
  }

  [HttpDelete("media-assets/{id:guid}")]
  public async Task<IActionResult> Delete(Guid id, CancellationToken cancellationToken)
  {
    var outcome = await store.DeleteAsync(id, cancellationToken).ConfigureAwait(false);
    return outcome switch
    {
      MediaAssetDeleteOutcome.NotFound => NotFound(new { error = "Unknown media asset." }),
      MediaAssetDeleteOutcome.Referenced =>
        Conflict(new { error = "This asset is used by an Action. Disable it instead of deleting it." }),
      _ => NoContent(),
    };
  }

  /// <summary>
  /// The only surface that exposes raw filesystem entries. <c>configuredSrcs</c> is computed
  /// here (from the local assets already in <see cref="IMediaAssetStore"/>), not by
  /// <see cref="IMediaFileCatalog"/> — see <see cref="MediaDiscovery"/>'s doc comment.
  /// </summary>
  [HttpGet("media/discovered")]
  public async Task<IActionResult> Discovered(CancellationToken cancellationToken)
  {
    var assets = await store.GetAllAsync(cancellationToken).ConfigureAwait(false);
    var configuredSrcs = assets
      .Where(a => a.SourceType == MediaSourceType.Local)
      .Select(a => a.Src)
      .Distinct(StringComparer.Ordinal)
      .ToList();

    return Ok(new MediaDiscovery(catalog.Discovered(), configuredSrcs));
  }
}
