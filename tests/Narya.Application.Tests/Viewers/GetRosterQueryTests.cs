using NSubstitute;

using Narya.Application.Viewers;
using Narya.Core.Viewers;

namespace Narya.Application.Tests.Viewers;

public sealed class GetRosterQueryTests
{
  [Fact]
  public async Task ReturnsTheStoresRoster()
  {
    var store = Substitute.For<IViewerStore>();
    IReadOnlyList<ViewerRosterEntry> roster =
    [
      new ViewerRosterEntry(
        Login: "viewer", Display: "Viewer", Color: "#111111", Roles: ["sub"],
        MessageCount: 2, FirstSeenAt: DateTimeOffset.UtcNow, LastSeenAt: DateTimeOffset.UtcNow, Note: ""),
    ];
    _ = store.GetRosterAsync(Arg.Any<CancellationToken>()).Returns(roster);
    var handler = new GetRosterQueryHandler(store);

    var result = await handler.Handle(new GetRosterQuery(), CancellationToken.None);

    Assert.Same(roster, result);
  }
}
