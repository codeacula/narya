using FluentResults;

using FluentValidation;

using MediatR;

using Microsoft.Extensions.DependencyInjection;

using Narya.Application.Behaviors;

namespace Narya.Application.Tests.Behaviors;

public sealed record EchoCommand(string Text) : IRequest<Result<string>>;

public sealed class EchoValidator : AbstractValidator<EchoCommand>
{
  public EchoValidator()
  {
    _ = RuleFor(x => x.Text).NotEmpty().WithMessage("text is required");
  }
}

public sealed class EchoHandler : IRequestHandler<EchoCommand, Result<string>>
{
  public static bool WasCalled { get; set; }

  public Task<Result<string>> Handle(EchoCommand request, CancellationToken cancellationToken)
  {
    WasCalled = true;
    return Task.FromResult(Result.Ok(request.Text));
  }
}

public sealed class ValidationBehaviorTests
{
  private static IMediator BuildMediator() => new ServiceCollection()
    .AddLogging()
    .AddSingleton<IValidator<EchoCommand>, EchoValidator>()
    .AddMediatR(cfg =>
    {
      _ = cfg.RegisterServicesFromAssemblyContaining<ValidationBehaviorTests>();
      _ = cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
    })
    .BuildServiceProvider()
    .GetRequiredService<IMediator>();

  [Fact]
  public async Task InvalidRequestFailsWithoutReachingHandler()
  {
    EchoHandler.WasCalled = false;
    var result = await BuildMediator().Send(new EchoCommand(""));
    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "text is required");
    Assert.False(EchoHandler.WasCalled);
  }

  [Fact]
  public async Task ValidRequestReachesHandler()
  {
    var result = await BuildMediator().Send(new EchoCommand("hi"));
    Assert.True(result.IsSuccess);
    Assert.Equal("hi", result.Value);
  }
}
