package fixtures.orders;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.util.List;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(value = "/api/orders", produces = MediaType.APPLICATION_JSON_VALUE)
public class OrdersController {
  @GetMapping(value = "/{orderId}", headers = "X-Channel=partner")
  public OrderResponse findPartnerOrder(@PathVariable String orderId,
      @RequestHeader("X-Channel") String channel) {
    return new OrderResponse(orderId, "partner");
  }

  @GetMapping(value = "/{orderId}", headers = "X-Channel=internal",
      produces = "application/vnd.orders.internal+json")
  public OrderResponse findInternalOrder(@PathVariable String orderId,
      @RequestHeader("X-Channel") String channel) {
    return new OrderResponse(orderId, "internal");
  }

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public OrderResponse createOrder(@Valid @RequestBody CreateOrderRequest request) {
    return new OrderResponse("ord-java-1", "pending");
  }

  public record CreateOrderRequest(@Valid Customer customer, @NotEmpty List<@Valid LineItem> items) {}
  public record Customer(@NotBlank String id, @Valid Address address) {}
  public record Address(@NotBlank String city) {}
  public record LineItem(@NotBlank String sku, @Min(1) int quantity) {}
  public record OrderResponse(String id, String state) {}
}
