using Narya.Application.Actions;

namespace Narya.Application.Tests.Actions;

/// <summary>
/// Pure unit tests for <see cref="ActionTemplate.Render"/> — a port of legacy's
/// <c>renderActionTemplate</c> test coverage (<c>legacy/src/server/actionTemplates.ts</c>). No
/// ports, no doubles: the renderer takes only a template string and a <see cref="TemplateContext"/>.
/// </summary>
public sealed class ActionTemplateTests
{
  // ---------------------------------------------------------------------------------------
  // Static tokens
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void ActorTokenSubstitutesTheActorField()
  {
    var context = new TemplateContext { Actor = "Sorlus" };

    var result = ActionTemplate.Render("Welcome, {actor}!", context);

    Assert.Equal("Welcome, Sorlus!", result);
  }

  [Fact]
  public void EveryStaticTokenSubstitutesItsOwnField()
  {
    var context = new TemplateContext
    {
      Actor = "Sorlus",
      Login = "sorlus",
      Message = "hello",
      Input = "the input",
      RewardTitle = "Hydrate",
      Amount = 500,
      Tier = "1000",
      Months = 6,
      Category = "Just Chatting",
      Module = "chatting-module",
    };

    var result = ActionTemplate.Render(
      "{actor}|{login}|{message}|{input}|{rewardTitle}|{amount}|{tier}|{months}|{category}|{module}", context);

    Assert.Equal("Sorlus|sorlus|hello|the input|Hydrate|500|1000|6|Just Chatting|chatting-module", result);
  }

  [Fact]
  public void ArgsTokenJoinsEveryArgumentWithASpace()
  {
    var context = new TemplateContext { Args = ["quack", "loudly", "please"] };

    var result = ActionTemplate.Render("{args}", context);

    Assert.Equal("quack loudly please", result);
  }

  // ---------------------------------------------------------------------------------------
  // {argN} / {rest} / {restN}
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void Arg1TokenIndexesTheFirstArgument()
  {
    var context = new TemplateContext { Args = ["bob", "hi", "there"] };

    var result = ActionTemplate.Render("{arg1}", context);

    Assert.Equal("bob", result);
  }

  [Fact]
  public void ArgNTokenIndexesTheNthArgumentOneIndexed()
  {
    var context = new TemplateContext { Args = ["bob", "hi", "there"] };

    var result = ActionTemplate.Render("{arg2} {arg3}", context);

    Assert.Equal("hi there", result);
  }

  [Fact]
  public void OutOfRangeArgNRendersEmptyNotTheLiteralToken()
  {
    var context = new TemplateContext { Args = ["bob"] };

    var result = ActionTemplate.Render("[{arg5}]", context);

    Assert.Equal("[]", result);
  }

  [Fact]
  public void RestTokenIsEveryArgumentAfterTheFirst()
  {
    // The whisper example from actionTemplates.ts's own doc comment: `/whisper bob hi there`
    // binds {arg1} as the target and {rest} as the message ("hi there"), not the whole {args}.
    var context = new TemplateContext { Args = ["bob", "hi", "there"] };

    var result = ActionTemplate.Render("{arg1}: {rest}", context);

    Assert.Equal("bob: hi there", result);
  }

  [Fact]
  public void RestOneIsIdenticalToBareRest()
  {
    var context = new TemplateContext { Args = ["bob", "hi", "there"] };

    var rest = ActionTemplate.Render("{rest}", context);
    var rest1 = ActionTemplate.Render("{rest1}", context);

    Assert.Equal(rest, rest1);
    Assert.Equal("hi there", rest);
  }

  [Fact]
  public void RestNSkipsTheFirstNArguments()
  {
    var context = new TemplateContext { Args = ["bob", "300", "spamming", "chat"] };

    var result = ActionTemplate.Render("{rest2}", context);

    Assert.Equal("spamming chat", result);
  }

  [Fact]
  public void RestPastTheEndOfArgsRendersEmpty()
  {
    var context = new TemplateContext { Args = ["bob"] };

    var result = ActionTemplate.Render("[{rest3}]", context);

    Assert.Equal("[]", result);
  }

  // ---------------------------------------------------------------------------------------
  // Known-null vs. unknown-literal
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void KnownTokenWithNoValueRendersEmptyNotTheLiteralToken()
  {
    var context = new TemplateContext();

    var result = ActionTemplate.Render("Cheers for {months} months, {actor}!", context);

    Assert.Equal("Cheers for  months, !", result);
  }

  [Fact]
  public void UnknownTokenIsLeftIntact()
  {
    var context = new TemplateContext { Actor = "Sorlus" };

    var result = ActionTemplate.Render("{actor} says {typo}", context);

    Assert.Equal("Sorlus says {typo}", result);
  }

  [Theory]
  [InlineData("{Actor}")] // wrong case
  [InlineData("{arg0}")] // 1-indexed only — 0 is not a valid arg position
  [InlineData("{rest0}")]
  [InlineData("{unknown}")]
  public void VariousUnknownShapesAreLeftIntact(string template)
  {
    var result = ActionTemplate.Render(template, new TemplateContext());

    Assert.Equal(template, result);
  }

  // ---------------------------------------------------------------------------------------
  // Single-pass / anti-injection
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void AnInterpolatedValueContainingTokenShapedTextIsNeverReExpanded()
  {
    // Chat text is attacker-controlled: a viewer's message literally reading "{actor}" must not
    // be re-expanded into the actual actor's name on a second pass.
    var context = new TemplateContext { Actor = "Sorlus", Message = "{actor}" };

    var result = ActionTemplate.Render("{actor} said: {message}", context);

    Assert.Equal("Sorlus said: {actor}", result);
  }

  [Fact]
  public void AnInterpolatedArgContainingTokenShapedTextIsNeverReExpanded()
  {
    var context = new TemplateContext { Args = ["{arg2}", "gotcha"] };

    var result = ActionTemplate.Render("{arg1}", context);

    Assert.Equal("{arg2}", result);
  }

  // ---------------------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void EmptyTemplateRendersEmpty()
  {
    Assert.Equal(string.Empty, ActionTemplate.Render(string.Empty, new TemplateContext()));
    Assert.Equal(string.Empty, ActionTemplate.Render(null, new TemplateContext()));
  }

  [Fact]
  public void TemplateWithNoTokensPassesThroughUnchanged()
  {
    var result = ActionTemplate.Render("plain text with no tokens", new TemplateContext());

    Assert.Equal("plain text with no tokens", result);
  }

  [Fact]
  public void MultipleOccurrencesOfTheSameTokenAllSubstitute()
  {
    var context = new TemplateContext { Actor = "Sorlus" };

    var result = ActionTemplate.Render("{actor}, {actor}, {actor}!", context);

    Assert.Equal("Sorlus, Sorlus, Sorlus!", result);
  }
}
