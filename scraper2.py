import requests
from bs4 import BeautifulSoup
import csv
import time
import random
import logging

def scrape_data(website_url, data_extraction_logic, data_headers, csv_file):
    try:
        # Send a GET request to the website with a User-Agent header
        headers = {'User-Agent': generate_random_user_agent()}
        response = requests.get(website_url, headers=headers)
        response.raise_for_status()

        # Create a BeautifulSoup object to parse the HTML content
        soup = BeautifulSoup(response.content, 'html.parser')

        # Extract the desired data from the website using the provided data_extraction_logic
        extracted_data = data_extraction_logic(soup)

        # Store the extracted data in a CSV file
        with open(csv_file, 'w', newline='') as file:
            writer = csv.writer(file)
            writer.writerow(data_headers)
            writer.writerows(extracted_data)

        logging.info("Data extraction complete! The data has been stored in the CSV file.")

    except requests.exceptions.RequestException as e:
        logging.error(f"An error occurred while accessing the website: {e}")

    except Exception as e:
        logging.error(f"An error occurred during scraping: {e}")

def generate_random_user_agent():
    user_agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.82 Safari/537.36',
    ]

    return random.choice(user_agents)

# Define the data extraction logic for customer data
def extract_customer_data(soup):
    customer_data = []
    customer_elements = soup.find_all('div', class_='customer-info')
    for element in customer_elements:
        try:
            name = element.find('span', class_='name').text
            email = element.find('span', class_='email').text
            phone = element.find('span', class_='phone').text
            customer_data.append([name, email, phone])
        except AttributeError:
            logging.warning("Missing or invalid data for a customer. Skipping...")
    return customer_data

# Define the data extraction logic for product data
def extract_product_data(soup):
    product_data = []
    product_elements = soup.find_all('div', class_='product-info')
    for element in product_elements:
        try:
            name = element.find('span', class_='name').text
            price = element.find('span', class_='price').text
            description = element.find('span', class_='description').text
            product_data.append([name, price, description])
        except AttributeError:
            logging.warning("Missing or invalid data for a product. Skipping...")
    return product_data

# Replace 'website_url' with the URL of the website you want to scrape
website_url = 'https://www.example.com'

# Configure logging
logging.basicConfig(filename='scraping.log', level=logging.INFO)

# Define the desired data extraction logic, headers, and CSV file for customer data
customer_data_extraction_logic = extract_customer_data
customer_data_headers = ['Name', 'Email', 'Phone']
customer_csv_file = 'customer_data.csv'

# Scrape customer data
scrape_data(website_url, customer_data_extraction_logic, customer_data_headers, customer_csv_file)

# Define the desired data extraction logic, headers, and CSV file for product data
product_data_extraction_logic = extract_product_data
product_data_headers = ['Name', 'Price', 'Description']
product_csv_file = 'product_data.csv'

# Scrape product data
scrape_data(website_url, product_data_extraction_logic, product_data_headers, product_csv_file)