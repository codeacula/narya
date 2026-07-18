using NSubstitute;

using Narya.Application.Viewers;
using Narya.Core.Viewers;

namespace Narya.Application.Tests.Viewers;

public sealed class UpdateViewerProfileCommandTests
{
  private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
  {
    public override DateTimeOffset GetUtcNow() => now;
  }

  [Fact]
  public async Task LowercasesTheLoginAndForwardsToTheStoreWithTheCurrentTime()
  {
    var store = Substitute.For<IViewerStore>();
    var now = DateTimeOffset.Parse("2026-07-17T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    _ = store.UpsertProfileAsync(
      "viewer", "Real Name", Arg.Any<IReadOnlyList<string>>(), "a note", now, Arg.Any<CancellationToken>())
      .Returns(new ViewerProfileUpdate("Real Name", ["fan"], "a note"));
    var handler = new UpdateViewerProfileCommandHandler(store, new FixedTimeProvider(now));

    var result = await handler.Handle(
      new UpdateViewerProfileCommand("VIEWER", "Real Name", ["fan"], "a note"), CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("Real Name", result.Value.RealName);
    _ = await store.Received(1).UpsertProfileAsync(
      "viewer", "Real Name", Arg.Any<IReadOnlyList<string>>(), "a note", now, Arg.Any<CancellationToken>());
  }
}

public sealed class UpdateViewerProfileCommandValidatorTests
{
  private readonly UpdateViewerProfileCommandValidator validator = new();

  [Fact]
  public void PassesWithValidInput()
  {
    var result = validator.Validate(new UpdateViewerProfileCommand("viewer", "Real Name", ["fan"], "a note"));

    Assert.True(result.IsValid);
  }

  [Fact]
  public void PassesWithAllNullOptionalFields()
  {
    var result = validator.Validate(new UpdateViewerProfileCommand("viewer", null, null, null));

    Assert.True(result.IsValid);
  }

  [Fact]
  public void FailsWhenLoginIsBlank()
  {
    var result = validator.Validate(new UpdateViewerProfileCommand("   ", null, null, null));

    Assert.False(result.IsValid);
  }

  [Fact]
  public void FailsWhenRealNameExceeds120CharactersAfterTrimming()
  {
    var result = validator.Validate(
      new UpdateViewerProfileCommand("viewer", new string('x', 121), null, null));

    Assert.False(result.IsValid);
  }

  [Fact]
  public void PassesWhenRealNameIsExactly120CharactersAfterTrimming()
  {
    var result = validator.Validate(
      new UpdateViewerProfileCommand("viewer", "  " + new string('x', 120) + "  ", null, null));

    Assert.True(result.IsValid);
  }

  [Fact]
  public void FailsWhenNoteExceeds1000Characters()
  {
    var result = validator.Validate(
      new UpdateViewerProfileCommand("viewer", null, null, new string('x', 1001)));

    Assert.False(result.IsValid);
  }

  [Fact]
  public void FailsWhenMoreThanTwelveTagsAreProvided()
  {
    var tags = Enumerable.Range(0, 13).Select(i => $"tag{i}").ToList();

    var result = validator.Validate(new UpdateViewerProfileCommand("viewer", null, tags, null));

    Assert.False(result.IsValid);
  }

  [Fact]
  public void PassesWithExactlyTwelveTags()
  {
    var tags = Enumerable.Range(0, 12).Select(i => $"tag{i}").ToList();

    var result = validator.Validate(new UpdateViewerProfileCommand("viewer", null, tags, null));

    Assert.True(result.IsValid);
  }

  [Fact]
  public void FailsWhenATagExceeds32CharactersAfterTrimming()
  {
    var result = validator.Validate(
      new UpdateViewerProfileCommand("viewer", null, [new string('x', 33)], null));

    Assert.False(result.IsValid);
  }

  [Fact]
  public void FailsWhenATagIsNull()
  {
    var result = validator.Validate(
      new UpdateViewerProfileCommand("viewer", null, [null!], null));

    Assert.False(result.IsValid);
  }
}
