using FluentResults;

using FluentValidation;

using MediatR;

namespace Narya.Application.Behaviors;

public sealed class ValidationBehavior<TRequest, TResponse>(IEnumerable<IValidator<TRequest>> validators)
  : IPipelineBehavior<TRequest, TResponse>
  where TRequest : notnull
  where TResponse : ResultBase, new()
{
  public async Task<TResponse> Handle(
    TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
  {
    var errors = new List<IError>();
    foreach (var validator in validators)
    {
      var validation = await validator.ValidateAsync(request, cancellationToken);
      errors.AddRange(validation.Errors.Select(e => (IError)new Error(e.ErrorMessage)));
    }

    if (errors.Count == 0)
    {
      return await next(cancellationToken);
    }

    var failed = new TResponse();
    failed.Reasons.AddRange(errors);
    return failed;
  }
}
